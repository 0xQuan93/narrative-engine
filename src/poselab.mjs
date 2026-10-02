/**
 * Read PoseLab's already-retargeted normalized animation JSON, not raw FBX.
 * Mapping follows PoseLab's VRMRigMapMixamo.ts (MIT, Project 89). The saved
 * bank has no source-VRM metadata: sourceVrm is an explicit playback convention,
 * not a claim about the historical avatar used to export it. PoseLab plays bank
 * rotations directly on native normalized bones and strips hips translation.
 */
import { QuaternionKeyframeTrack, Quaternion, InterpolateLinear, InterpolateDiscrete, REVISION } from 'three';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const POSELAB_ADAPTER_VERSION = 'poselab-normalized/0.1';
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const BONE_NAMES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye', 'jaw',
  ...['left', 'right'].flatMap((side) => ['UpperLeg', 'LowerLeg', 'Foot', 'Toes', 'Shoulder', 'UpperArm',
    'LowerArm', 'Hand', 'ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal',
    ...['Index', 'Middle', 'Ring', 'Little'].flatMap((finger) => ['Proximal', 'Intermediate', 'Distal'].map((joint) => finger + joint))
  ].map((bone) => side + bone))];
const BONES = new Set(BONE_NAMES);
const MIXAMO = new Map(Object.entries({ Hips: 'hips', Spine: 'spine', Spine1: 'chest', Spine2: 'upperChest', Neck: 'neck', Head: 'head' }));
for (const side of ['Left', 'Right']) {
  const lower = side.toLowerCase();
  for (const [source, target] of Object.entries({ Shoulder: 'Shoulder', Arm: 'UpperArm', ForeArm: 'LowerArm', Hand: 'Hand',
    UpLeg: 'UpperLeg', Leg: 'LowerLeg', Foot: 'Foot', ToeBase: 'Toes' })) MIXAMO.set(side + source, lower + target);
  for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
    const joints = finger === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
    joints.forEach((joint, index) => MIXAMO.set(`${side}Hand${finger}${index + 1}`, `${lower}${finger === 'Pinky' ? 'Little' : finger}${joint}`));
  }
}
const fail = (message) => { throw new Error(`PoseLab import: ${message}`); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** No suffix guessing: raw Mixamo/Armature paths must be retargeted in PoseLab. */
export function mapPoseLabTrack(name) {
  if (typeof name !== 'string' || name.length > 4096) fail('invalid track name');
  const match = name.match(/^(.+)\.(quaternion|position)$/);
  if (!match) fail(`unsupported property in track ${name}`);
  const parts = match[1].split('/');
  if (parts.length > 1 && (parts[0] !== 'VRMHumanoidRig' || parts.slice(1).some((part) => !part.startsWith('Normalized_')))) {
    fail(`ambiguous raw bone path ${name}; expected VRMHumanoidRig/Normalized_...`);
  }
  const leaf = parts.at(-1);
  let bone;
  if (BONES.has(leaf)) bone = leaf;
  else if (leaf.startsWith('Normalized_')) {
    const normalizedName = leaf.slice('Normalized_'.length);
    if (BONES.has(normalizedName)) bone = normalizedName;
    else {
      const mixamo = normalizedName.match(/^mixamorig[:_]?(.+)$/);
      if (mixamo) bone = MIXAMO.get(mixamo[1]);
    }
  }
  if (!bone) fail(`unrecognized or ambiguous normalized bone in ${name}`);
  return { bone, property: match[2] };
}

function validateTrack(track, duration) {
  if (!object(track) || Object.keys(track).some((key) => !['name', 'type', 'times', 'values', 'interpolation'].includes(key))) fail('malformed or unsupported track fields');
  const mapping = mapPoseLabTrack(track.name);
  const size = mapping.property === 'quaternion' ? 4 : 3;
  if (track.type !== (size === 4 ? 'quaternion' : 'vector')) fail(`track type/property mismatch: ${track.name}`);
  if (!Array.isArray(track.times) || !track.times.length || track.times.length > 100000
      || !Array.isArray(track.values) || track.values.length !== track.times.length * size) fail(`invalid track sample sizes: ${track.name}`);
  for (let i = 0; i < track.times.length; i++) {
    const time = track.times[i];
    if (!Number.isFinite(time) || time < 0 || time > duration || (i > 0 && time <= track.times[i - 1])) fail(`track times must be finite, increasing, and inside duration: ${track.name}`);
  }
  if (track.values.some((value) => !Number.isFinite(value))) fail(`non-finite track values: ${track.name}`);
  if (size === 4) for (let i = 0; i < track.values.length; i += 4) {
    if (Math.abs(Math.hypot(...track.values.slice(i, i + 4)) - 1) > 0.01) fail(`invalid unit quaternion: ${track.name}`);
  }
  if (track.interpolation !== undefined && ![InterpolateLinear, InterpolateDiscrete].includes(track.interpolation)) fail(`unsupported interpolation: ${track.name}`);
  if (mapping.property === 'position' && mapping.bone !== 'hips') fail(`non-hips absolute position needs a source rest skeleton: ${track.name}`);
  return mapping;
}

/**
 * Bake actual Three track interpolants at exact frame/fps times plus clip end.
 * Result rotations use canonical VRM1 axes. Hips translation is removed,
 * matching PoseLab's in-place bank loader. Untracked bones remain at rest.
 */
export function samplePoseLabClip(clip, { fps = 30, sourceVrm } = {}) {
  if (!['0', '1'].includes(sourceVrm)) fail('sourceVrm must explicitly be "0" or "1"; bank JSON does not declare it');
  if (!Number.isInteger(fps) || fps < 1 || fps > 240) fail('fps must be an integer from 1 to 240');
  if (!object(clip) || Object.keys(clip).some((key) => !['name', 'duration', 'tracks'].includes(key))) fail('unsupported clip fields');
  if (typeof clip.name !== 'string' || !clip.name.length || clip.name.length > 256) fail('invalid clip name');
  if (!Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > 600) fail('duration must be in (0,600] seconds');
  if (!Array.isArray(clip.tracks) || !clip.tracks.length || clip.tracks.length > 256) fail('expected 1..256 tracks');
  if (Math.ceil(clip.duration * fps) > 36000) fail('resampling exceeds 36,000 frames');
  const channels = new Set();
  const interpolants = [];
  const skippedTracks = [];
  for (const track of clip.tracks) {
    const { bone, property } = validateTrack(track, clip.duration);
    const channel = `${bone}.${property}`;
    if (channels.has(channel)) fail(`duplicate mapped channel: ${channel}`);
    channels.add(channel);
    if (property === 'position') {
      skippedTracks.push({ name: track.name, reason: 'Absolute hips translation stripped to match PoseLab in-place playback' });
      continue;
    }
    const threeTrack = new QuaternionKeyframeTrack(track.name, track.times, track.values, track.interpolation ?? InterpolateLinear);
    for (let i = 1; i < threeTrack.times.length; i++) if (threeTrack.times[i] <= threeTrack.times[i - 1]) fail(`track times collapse at Three float32 precision: ${track.name}`);
    interpolants.push({ bone, interpolant: threeTrack.createInterpolant() });
  }
  if (!interpolants.length) fail('clip contains no supported rotation tracks');
  interpolants.sort((a, b) => a.bone.localeCompare(b.bone, 'en'));
  const sampleTimes = [];
  for (let frame = 0; frame / fps < clip.duration; frame++) sampleTimes.push(frame / fps);
  sampleTimes.push(clip.duration);
  const q = new Quaternion();
  const keyframes = sampleTimes.map((time, frame) => {
    const pose = {};
    for (const { bone, interpolant } of interpolants) {
      q.fromArray(interpolant.evaluate(time)).normalize();
      const rotation = q.toArray().map((value, i) => sourceVrm === '0' && i % 2 === 0 ? -value : value);
      pose[bone] = { rotation };
    }
    return { id: frame === sampleTimes.length - 1 ? 'clip-end' : `frame-${frame}`, time, pose, easing: 'linear' };
  });
  return {
    sequence: { duration: clip.duration, keyframes },
    summary: {
      adapter: POSELAB_ADAPTER_VERSION,
      threeRevision: REVISION,
      name: clip.name,
      duration: clip.duration,
      fps,
      sourceVrm,
      sourceConvention: 'Explicit native normalized playback convention; historical source avatar metadata absent',
      outputConvention: 'VRM1 normalized rest-relative rotations',
      axisConversion: sourceVrm === '0' ? 'Negate quaternion x and z (VRM0 to VRM1)' : 'Identity (VRM1)',
      playbackMode: 'in-place; all untracked bones reset to normalized rest pose',
      sourceTrackCount: clip.tracks.length,
      rotationTrackCount: interpolants.length,
      bones: interpolants.map(({ bone }) => bone),
      keyframeCount: keyframes.length,
      skippedTracks,
    },
  };
}

async function atomicWrite(filename, bytes) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, filename); }
  finally { await rm(temporary, { force: true }); }
}

/** Write canonical sequence and deterministic .source.json provenance sibling. */
export async function importPoseLabFile(sourcePath, outputPath, options) {
  const source = path.resolve(sourcePath);
  const output = path.resolve(outputPath);
  if (!output.endsWith('.json')) fail('output must end with .json');
  const provenancePath = output.slice(0, -5) + '.source.json';
  if (source === output || source === provenancePath) fail('output must not overwrite the source bank file');
  const info = await stat(source);
  if (!info.isFile() || info.size > MAX_SOURCE_BYTES) fail('source must be a JSON file no larger than 32 MiB');
  const bytes = await readFile(source);
  if (bytes.length > MAX_SOURCE_BYTES) fail('source exceeds 32 MiB');
  let clip;
  try { clip = JSON.parse(bytes.toString('utf8')); } catch { fail('invalid source JSON'); }
  const { sequence, summary } = samplePoseLabClip(clip, options);
  const serialized = JSON.stringify(sequence) + '\n';
  const provenance = {
    schema: 'narrative-motion-source/0.1',
    sourceFile: path.basename(source),
    sourceSha256: hash(bytes),
    sourceBytes: bytes.length,
    outputFile: path.basename(output),
    outputSha256: hash(serialized),
    ...summary,
  };
  await atomicWrite(output, serialized);
  await atomicWrite(provenancePath, JSON.stringify(provenance, null, 2) + '\n');
  return { output, provenancePath, provenance };
}
