import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mapPoseLabTrack, samplePoseLabClip, importPoseLabFile } from '../src/poselab.mjs';
import { evaluateEpisodeAtFrame } from '../src/episode.mjs';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const fixture = () => ({ name: 'test', duration: 1, tracks: [
  { name: 'VRMHumanoidRig/Normalized_mixamorigHips/Normalized_mixamorigSpine.quaternion', type: 'quaternion', times: [0, 1], values: [0, 0, 0, 1, 1, 0, 0, 0] },
  { name: 'VRMHumanoidRig/Normalized_mixamorigHips.position', type: 'vector', times: [0, 1], values: [0, 1, 0, 4, 1, 0] },
] });
function episode(sequence) { return { schema: 'narrative-episode/0.1', fps: 4, durationFrames: 4,
  actors: [{ id: 'actor', assetId: 'vrm' }], shots: [{ id: 'shot', startFrame: 0, durationFrames: 4,
    camera: { position: [0, 1, 3], target: [0, 1, 0], fov: 40 }, performances: [{ actorId: 'actor', sequence }] }] }; }

test('maps explicit normalized bank paths including thumb and pinky joints', () => {
  assert.deepEqual(mapPoseLabTrack('VRMHumanoidRig/Normalized_mixamorigRightHand/Normalized_mixamorigRightHandThumb1.quaternion'), { bone: 'rightThumbMetacarpal', property: 'quaternion' });
  assert.equal(mapPoseLabTrack('Normalized_mixamorigLeftHandThumb2.quaternion').bone, 'leftThumbProximal');
  assert.equal(mapPoseLabTrack('Normalized_mixamorigLeftHandPinky3.quaternion').bone, 'leftLittleDistal');
  assert.equal(mapPoseLabTrack('Normalized_upperChest.quaternion').bone, 'upperChest');
  assert.equal(mapPoseLabTrack('head.quaternion').bone, 'head');
  for (const raw of ['Armature/mixamorigRightArm.quaternion', 'mixamorigRightArm.quaternion', 'Normalized_Unknown.quaternion', 'head.scale']) {
    assert.throws(() => mapPoseLabTrack(raw), /ambiguous|unsupported|unrecognized/);
  }
});

test('samples Three quaternion interpolation at exact frames and converts native VRM0 axes', () => {
  const { sequence, summary } = samplePoseLabClip(fixture(), { fps: 4, sourceVrm: '0' });
  assert.deepEqual(sequence.keyframes.map((key) => key.time), [0, 0.25, 0.5, 0.75, 1]);
  const middle = sequence.keyframes[2].pose.spine.rotation;
  close(middle[0], -Math.SQRT1_2); close(middle[3], Math.SQRT1_2);
  assert.equal(summary.rotationTrackCount, 1); assert.equal(summary.skippedTracks.length, 1);
  assert.equal(sequence.keyframes[2].pose.hips, undefined);
  const one = samplePoseLabClip(fixture(), { fps: 4, sourceVrm: '1' }).sequence.keyframes[2].pose.spine.rotation;
  close(one[0], Math.SQRT1_2);
  const result = evaluateEpisodeAtFrame(episode(sequence), 2);
  close(result.actors[0].pose.spine.rotation[0], -Math.SQRT1_2);
});

test('clamps track ends, handles step interpolants and preserves fractional clip endpoint', () => {
  const clip = fixture(); clip.duration = 1.1;
  clip.tracks[0].times = [0.2, 0.8]; clip.tracks[0].interpolation = 2300;
  const result = samplePoseLabClip(clip, { fps: 4, sourceVrm: '1' });
  assert.deepEqual(result.sequence.keyframes.map((key) => key.time), [0, 0.25, 0.5, 0.75, 1, 1.1]);
  assert.deepEqual(result.sequence.keyframes[2].pose.spine.rotation, [0, 0, 0, 1]);
  assert.deepEqual(result.sequence.keyframes.at(-1).pose.spine.rotation, [1, 0, 0, 0]);
});

test('rejects missing convention, duplicate channels, nonfinite data and ambiguous translations', () => {
  assert.throws(() => samplePoseLabClip(fixture()), /sourceVrm/);
  const cases = [
    (clip) => { clip.tracks.push(structuredClone(clip.tracks[0])); },
    (clip) => { clip.tracks[0].times = [0, NaN]; },
    (clip) => { clip.tracks[0].values[0] = Infinity; },
    (clip) => { clip.tracks[0].values[3] = 0; },
    (clip) => { clip.tracks[1].name = 'Normalized_spine.position'; },
    (clip) => { clip.tracks[0].interpolation = 2302; },
    (clip) => { clip.tracks = []; },
  ];
  for (const change of cases) { const clip = fixture(); change(clip); assert.throws(() => samplePoseLabClip(clip, { sourceVrm: '0' })); }
});

test('writes source and output hashes with repeatable sequence/provenance bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'narrative-poselab-'));
  try {
    const source = path.join(root, 'bank-animation.json'); const out = path.join(root, 'wave.sequence.json');
    const sourceBytes = JSON.stringify(fixture()); await writeFile(source, sourceBytes);
    const first = await importPoseLabFile(source, out, { sourceVrm: '0', fps: 4 });
    const sequence = await readFile(out); const provenance = await readFile(first.provenancePath);
    assert.equal(first.provenance.sourceSha256, createHash('sha256').update(sourceBytes).digest('hex'));
    assert.equal(first.provenance.outputSha256, createHash('sha256').update(sequence).digest('hex'));
    await importPoseLabFile(source, out, { sourceVrm: '0', fps: 4 });
    assert.deepEqual(await readFile(out), sequence); assert.deepEqual(await readFile(first.provenancePath), provenance);
    await assert.rejects(importPoseLabFile(source, source, { sourceVrm: '0' }), /overwrite/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
