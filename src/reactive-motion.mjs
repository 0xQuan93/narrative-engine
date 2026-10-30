/**
 * Frame-deterministic reactive offsets on top of a PoseLab clip.
 *
 * The episode evaluator owns this layer so a Remotion frame does not depend on
 * seek order. @pixiv/three-vrm applies the resulting normalized pose and
 * expression weights. It does not run VRMLookAt or spring bones here:
 * look-at appliers need the loaded rig (and would double-apply these offsets),
 * and spring bones integrate from the previous tail position.
 *
 * Rotations are VRM 1 normalized deltas (+Y up, +Z forward, +X to the
 * character's left), the same convention as episode poses. The evaluator aims
 * a canonical T-pose right arm so tests can run without a VRM. At draw time
 * the stage re-solves that aim from the loaded arm rest (A-pose on typical
 * VRM 0) and, when look-at is bone-type, writes eye bones from the avatar's
 * range map. Spring bones stay frozen.
 */

import {canonicalExpressionName, resolveExpressionName} from './expression-names.mjs';

const REST = Object.freeze([0, 0, 0, 1]);
const YAW_LIMIT = 0.62;
const PITCH_LIMIT = 0.42;
const UPPER_ARM = 0.27;
const LOWER_ARM = 0.24;
const ARM_REST = Object.freeze([-1, 0, 0]);
const CCD_STEPS = 12;

export const ACTOR_SPACING = 1.7;
export const HEAD_ANCHOR = Object.freeze([0, 1.5, 0.02]);
export const REACTIVITY_MODES = Object.freeze(['off', 'subtle', 'lively']);
export const OPTIONAL_REACTIVE_EXPRESSIONS = new Set([
  'happy', 'angry', 'sad', 'relaxed', 'surprised',
  'blink', 'blinkLeft', 'blinkRight',
  'lookUp', 'lookDown', 'lookLeft', 'lookRight', 'neutral',
]);

const PRESETS = Object.freeze({
  subtle: Object.freeze({look: 'camera', head: 0.45, torso: 0.18, arm: 0.28, expression: 0.4}),
  lively: Object.freeze({look: 'camera', head: 0.78, torso: 0.42, arm: 0.62, expression: 0.75}),
});

const LOOK_BONES = Object.freeze([
  ['spine', 'torso', 0.16],
  ['chest', 'torso', 0.26],
  ['upperChest', 'torso', 0.2],
  ['neck', 'head', 0.2],
  ['head', 'head', 0.42],
]);
const HEAD_CHANNEL_CAP = 0.45;
const AIM_CONE = 32 * Math.PI / 180;
const AIM_UP_BIAS = 0.08;
const AIM_REACH = 0.96;
const AIM_BLEND_START = 0.18;
const AIM_BLEND_SPAN = 0.42;
const TORSO_YAW_SHARE = LOOK_BONES.filter(([, channel]) => channel === 'torso').reduce((sum, [, , share]) => sum + share, 0);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const clamp01 = (value) => clamp(value, 0, 1);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const hypot3 = (v) => Math.hypot(v[0], v[1], v[2]);

function normalize3(v) {
  const length = hypot3(v);
  if (length < 1e-8) return [0, 0, 1];
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function mul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function invertQuat(q) {
  const n = q[0] ** 2 + q[1] ** 2 + q[2] ** 2 + q[3] ** 2 || 1;
  return [-q[0] / n, -q[1] / n, -q[2] / n, q[3] / n];
}

function normalizeQuat(q) {
  const length = Math.hypot(...q) || 1;
  return q.map((v) => v / length);
}

function quatFromAxisAngle(axis, angle) {
  const half = angle * 0.5;
  const s = Math.sin(half);
  const u = normalize3(axis);
  return [u[0] * s, u[1] * s, u[2] * s, Math.cos(half)];
}

/** YXZ euler, matching VRMLookAt: x = pitch, y = yaw, z = roll. */
export function quatYXZ(yaw, pitch, roll = 0) {
  const c1 = Math.cos(pitch / 2);
  const c2 = Math.cos(yaw / 2);
  const c3 = Math.cos(roll / 2);
  const s1 = Math.sin(pitch / 2);
  const s2 = Math.sin(yaw / 2);
  const s3 = Math.sin(roll / 2);
  return normalizeQuat([
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3,
  ]);
}

export function rotateVector(q, v) {
  const p = [v[0], v[1], v[2], 0];
  const r = mul(mul(q, p), invertQuat(q));
  return [r[0], r[1], r[2]];
}

function slerp(left, right, t) {
  const a = normalizeQuat(left);
  let b = normalizeQuat(right);
  let cos = a.reduce((sum, v, i) => sum + v * b[i], 0);
  if (cos < 0) {
    b = b.map((v) => -v);
    cos = -cos;
  }
  cos = Math.min(1, cos);
  if (cos > 0.9995) return normalizeQuat(a.map((v, i) => v * (1 - t) + b[i] * t));
  const angle = Math.acos(cos);
  const denominator = Math.sin(angle);
  const weightA = Math.sin((1 - t) * angle) / denominator;
  const weightB = Math.sin(t * angle) / denominator;
  return normalizeQuat(a.map((v, i) => v * weightA + b[i] * weightB));
}

function fromToQuat(from, to) {
  const a = normalize3(from);
  const b = normalize3(to);
  const d = clamp(dot(a, b), -1, 1);
  if (d > 0.999999) return [0, 0, 0, 1];
  if (d < -0.999999) {
    const axis = Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]);
    return quatFromAxisAngle(axis, Math.PI);
  }
  const axis = cross(a, b);
  const s = Math.sqrt((1 + d) * 2);
  const inv = 1 / s;
  return normalizeQuat([axis[0] * inv, axis[1] * inv, axis[2] * inv, s * 0.5]);
}

export function actorHeadPosition(actorIndex, actorCount) {
  const x = (actorIndex - (actorCount - 1) / 2) * ACTOR_SPACING;
  return [HEAD_ANCHOR[0] + x, HEAD_ANCHOR[1], HEAD_ANCHOR[2]];
}

/** Yaw is positive toward +X (character left). Pitch is positive when looking down. */
export function lookAngles(from, to) {
  const dir = sub(to, from);
  const length = hypot3(dir);
  if (length < 1e-5) return {yaw: 0, pitch: 0};
  return {
    yaw: Math.atan2(dir[0], dir[2]),
    pitch: -Math.atan2(dir[1], Math.hypot(dir[0], dir[2])),
  };
}

function clonePose(pose) {
  return Object.fromEntries(Object.entries(pose).map(([bone, transform]) => [bone, {
    ...(transform.rotation ? {rotation: [...transform.rotation]} : {}),
    ...(transform.position ? {position: [...transform.position]} : {}),
  }]));
}

function additiveBone(pose, bone, yaw, pitch, roll) {
  if (Math.hypot(yaw, pitch, roll) < 1e-6) return;
  const base = pose[bone]?.rotation ?? REST;
  const position = pose[bone]?.position ? [...pose[bone].position] : [0, 0, 0];
  pose[bone] = {rotation: normalizeQuat(mul(quatYXZ(yaw, pitch, roll), base)), position};
}

function replaceBlend(pose, bone, targetRotation, amount) {
  const weight = clamp01(amount);
  if (weight <= 0) return;
  const base = pose[bone]?.rotation ?? REST;
  const position = pose[bone]?.position ? [...pose[bone].position] : [0, 0, 0];
  pose[bone] = {rotation: slerp(base, targetRotation, weight), position};
}

function clampReach(target, upperLength, lowerLength) {
  const length = hypot3(target);
  const max = upperLength + lowerLength - 1e-4;
  const min = Math.abs(upperLength - lowerLength) + 1e-4;
  if (length < 1e-8) return [-max, 0, 0];
  const clamped = Math.min(max, Math.max(min, length));
  const scale = clamped / length;
  return target.map((v) => v * scale);
}

function armForwardKinematics(qUpper, qLower, upperRest, lowerRest, upperLength, lowerLength) {
  const upperDir = rotateVector(qUpper, upperRest);
  const elbow = upperDir.map((v) => v * upperLength);
  const lowerDir = rotateVector(mul(qUpper, qLower), lowerRest);
  const hand = elbow.map((v, i) => v + lowerDir[i] * lowerLength);
  return {elbow, hand};
}

function initialLowerBend(lowerRest) {
  const rest = normalize3(lowerRest);
  if (dot(rest, ARM_REST) > 0.99) return quatFromAxisAngle([0, 1, 0], 0.55);
  const axis = cross(rest, [0, 0.35, 1]);
  if (hypot3(axis) < 1e-5) return [0, 0, 0, 1];
  return quatFromAxisAngle(axis, 0.65);
}

/**
 * Right-arm CCD. `target` is shoulder-local.
 * The default rest points along -X (canonical T-pose). Pass the loaded bone
 * directions to aim an A-pose; those directions are the child bone offsets.
 */
export function solveRightArm(target, {
  upperRest = ARM_REST,
  lowerRest = ARM_REST,
  upperLength = UPPER_ARM,
  lowerLength = LOWER_ARM,
} = {}) {
  const upper = normalize3(upperRest);
  const lower = normalize3(lowerRest);
  const goal = clampReach(target, upperLength, lowerLength);
  let qUpper = [0, 0, 0, 1];
  let qLower = initialLowerBend(lower);
  for (let step = 0; step < CCD_STEPS; step += 1) {
    const lowerPose = armForwardKinematics(qUpper, qLower, upper, lower, upperLength, lowerLength);
    const lowerDelta = fromToQuat(sub(lowerPose.hand, lowerPose.elbow), sub(goal, lowerPose.elbow));
    qLower = normalizeQuat(mul(invertQuat(qUpper), mul(lowerDelta, mul(qUpper, qLower))));
    const upperPose = armForwardKinematics(qUpper, qLower, upper, lower, upperLength, lowerLength);
    const upperDelta = fromToQuat(upperPose.hand, goal);
    qUpper = normalizeQuat(mul(upperDelta, qUpper));
  }
  return {upper: qUpper, lower: qLower, goal, upperRest: upper, lowerRest: lower, upperLength, lowerLength};
}

export function rightArmHand(solution) {
  return armForwardKinematics(
    solution.upper,
    solution.lower,
    solution.upperRest ?? ARM_REST,
    solution.lowerRest ?? ARM_REST,
    solution.upperLength ?? UPPER_ARM,
    solution.lowerLength ?? LOWER_ARM,
  ).hand;
}

function rotateToward(from, to, t) {
  const start = normalize3(from);
  const q = fromToQuat(start, normalize3(to));
  const angle = 2 * Math.acos(clamp(q[3], -1, 1));
  if (angle < 1e-5) return start;
  return rotateVector(quatFromAxisAngle([q[0], q[1], q[2]], angle * t), start);
}

function coneClamp(direction, axis, maxAngle) {
  const aimed = normalize3(direction);
  const forward = normalize3(axis);
  const angle = Math.acos(clamp(dot(aimed, forward), -1, 1));
  if (angle <= maxAngle) return aimed;
  return rotateToward(forward, aimed, maxAngle / angle);
}

/** Chest-local unit aim. Yaw already applied to the torso is removed so the arm does not swing twice. */
export function pointAimDirection(camera, actorIndex, actorCount, torsoYaw = 0) {
  const head = actorHeadPosition(actorIndex, actorCount);
  const shoulder = [head[0] - 0.16, head[1] - 0.32, head[2]];
  let direction = normalize3(sub(camera.position, shoulder));
  if (Math.abs(torsoYaw) > 1e-6) direction = rotateVector(quatYXZ(-torsoYaw, 0, 0), direction);
  direction = normalize3([direction[0], direction[1] + AIM_UP_BIAS, direction[2]]);
  return coneClamp(direction, [0, 0, 1], AIM_CONE);
}

function aimBlend(raw) {
  const t = clamp01((raw - AIM_BLEND_START) / AIM_BLEND_SPAN);
  return t * t * (3 - 2 * t);
}

function fingerCurl(angle) {
  return quatFromAxisAngle([0, 0, 1], angle);
}

/**
 * Local point pose in VRM 1 axes. Index stays extended, the other fingers curl
 * into the palm (-Y), and the wrist rolls so the thumb lifts instead of hanging.
 * Missing finger bones are skipped when the pose is applied.
 */
export function pointHandRotations() {
  const curl = fingerCurl;
  return {
    rightHand: quatFromAxisAngle([1, 0, 0], -0.55),
    rightThumbMetacarpal: normalizeQuat(mul(curl(0.45), quatFromAxisAngle([0, 1, 0], 0.35))),
    rightThumbProximal: curl(0.55),
    rightThumbDistal: curl(0.4),
    rightIndexProximal: curl(0.12),
    rightIndexIntermediate: curl(0.08),
    rightIndexDistal: curl(0.05),
    rightMiddleProximal: curl(1.15),
    rightMiddleIntermediate: curl(1.25),
    rightMiddleDistal: curl(0.85),
    rightRingProximal: curl(1.25),
    rightRingIntermediate: curl(1.35),
    rightRingDistal: curl(0.9),
    rightLittleProximal: curl(1.3),
    rightLittleIntermediate: curl(1.4),
    rightLittleDistal: curl(0.95),
  };
}

/** Blend a clip arm toward a measured-rest solve. Directions are in one bone space. */
export function applyMeasuredAim({
  upper, lower, direction, weight,
  upperRest, lowerRest, upperLength, lowerLength,
}) {
  const reach = AIM_REACH * (upperLength + lowerLength);
  const solved = solveRightArm(direction.map((value) => value * reach), {
    upperRest, lowerRest, upperLength, lowerLength,
  });
  const blend = clamp01(weight);
  return {
    upper: slerp(upper, solved.upper, blend),
    lower: slerp(lower, solved.lower, blend),
    hand: rightArmHand(solved),
  };
}

const DEFAULT_LOOK_MAP = (degrees) => 10 * clamp01(degrees / 90);

/**
 * Eye quaternions for a bone look-at applier.
 * Yaw is positive toward +X. Pitch is positive looking down.
 * Maps take degrees and return degrees, matching VRMLookAtRangeMap.map.
 * The pitch branch matches VRMLookAtBoneApplier.applyYawPitch.
 */
export function boneLookEyeRotations(yawRad, pitchRad, maps = {}) {
  const horizontalInner = maps.horizontalInner ?? DEFAULT_LOOK_MAP;
  const horizontalOuter = maps.horizontalOuter ?? DEFAULT_LOOK_MAP;
  const verticalDown = maps.verticalDown ?? DEFAULT_LOOK_MAP;
  const verticalUp = maps.verticalUp ?? DEFAULT_LOOK_MAP;
  const yawDeg = yawRad * 180 / Math.PI;
  const pitchDeg = pitchRad * 180 / Math.PI;
  const pitch = pitchDeg < 0 ? -verticalDown(-pitchDeg) : verticalUp(pitchDeg);
  const leftYaw = yawDeg < 0 ? -horizontalInner(-yawDeg) : horizontalOuter(yawDeg);
  const rightYaw = yawDeg < 0 ? -horizontalOuter(-yawDeg) : horizontalInner(yawDeg);
  const toRad = (degrees) => degrees * Math.PI / 180;
  return {
    left: quatYXZ(toRad(leftYaw), toRad(pitch), 0),
    right: quatYXZ(toRad(rightYaw), toRad(pitch), 0),
  };
}

function windowPulse(frame, start, duration, strength) {
  if (frame < start || frame >= start + duration) return 0;
  const u = (frame - start) / duration;
  return Math.sin(Math.PI * u) * strength;
}

function sentenceStart(words, index) {
  if (index === 0) return true;
  return /[.!?]/.test(words[index - 1].text);
}

function derivedBeats(dialogue, shotStart, shotEnd) {
  if (!dialogue?.captions?.length) return [];
  const words = dialogue.captions.flatMap((caption) => caption.words);
  const beats = [];
  words.forEach((word, index) => {
    if (word.startFrame < shotStart || word.startFrame >= shotEnd) return;
    if (word.text.includes('!')) beats.push({frame: word.startFrame, kind: 'point', strength: 0.9, duration: 14});
    else if (word.text.includes('?')) beats.push({frame: word.startFrame, kind: 'lean', strength: 0.75, duration: 12});
    else if (sentenceStart(words, index)) beats.push({frame: word.startFrame, kind: 'nod', strength: 0.7, duration: 10});
  });
  return beats;
}

function episodeTimed(items, shotStart) {
  if (!items?.length) return [];
  return items.map((item) => ({...item, frame: item.frame + shotStart}));
}

function beatLevels(frame, beats) {
  const levels = {nod: 0, point: 0, lean: 0};
  for (const beat of beats) {
    const amount = windowPulse(frame, beat.frame, beat.duration ?? 12, beat.strength ?? 1);
    levels[beat.kind] = clamp01(levels[beat.kind] + amount);
  }
  return levels;
}

function dominantBeat(levels) {
  const ranked = [['point', levels.point], ['lean', levels.lean], ['nod', levels.nod]];
  ranked.sort((a, b) => b[1] - a[1]);
  return ranked[0][1] > 0 ? ranked[0][0] : null;
}

function cameraPunch(camera, previous) {
  const distance = (value) => Math.hypot(
    value.position[0] - value.target[0],
    value.position[1] - value.target[1],
    value.position[2] - value.target[2],
  );
  const approach = clamp((distance(previous) - distance(camera)) / 0.015, 0, 1);
  const fovPunch = clamp((previous.fov - camera.fov) / 0.25, 0, 1);
  return clamp(Math.max(approach, fovPunch), 0, 1);
}

function wordEnergy(dialogueState, frame) {
  if (!dialogueState?.caption || dialogueState.wordIndex < 0) return 0;
  const word = dialogueState.caption.words[dialogueState.wordIndex];
  const span = Math.max(1, word.endFrame - word.startFrame);
  const u = (frame - word.startFrame) / span;
  if (u < 0 || u > 1) return 0;
  return Math.sin(Math.PI * u);
}

function cueLevel(frame, cues) {
  let peak = 0;
  for (const cue of cues) peak = Math.max(peak, windowPulse(frame, cue.frame, cue.duration ?? 8, cue.intensity));
  return clamp01(peak);
}

function armWindow(frame, delay = 0) {
  if (!delay) return 1;
  if (frame < delay) return 0;
  if (frame >= delay + 8) return 1;
  const u = (frame - delay) / 8;
  return u * u * (3 - 2 * u);
}

function tightenMouth(expressions, dialogue, frame, amount, intensity) {
  if (!dialogue || amount <= 0) return expressions;
  const out = {...expressions};
  const cues = dialogue.mouthCues ?? [];
  const index = cues.findIndex((cue) => frame >= cue.startFrame && frame < cue.endFrame);
  if (index < 0) return out;
  const cue = cues[index];
  const span = Math.max(1, cue.endFrame - cue.startFrame);
  const u = (frame - cue.startFrame) / span;
  const shaped = clamp01(cue.weight * Math.sin(Math.PI * clamp01(u)) * (1 + 0.25 * intensity));
  const current = out[cue.shape] ?? 0;
  out[cue.shape] = clamp01(current * (1 - amount) + shaped * amount);
  const neighbor = 0.32 * amount;
  if (u < 0.34 && index > 0 && cue.startFrame - cues[index - 1].endFrame <= 3) {
    const previous = cues[index - 1];
    const mix = ((0.34 - u) / 0.34) * neighbor;
    out[previous.shape] = clamp01((out[previous.shape] ?? 0) + previous.weight * mix);
  }
  if (u > 0.66 && index + 1 < cues.length && cues[index + 1].startFrame - cue.endFrame <= 3) {
    const next = cues[index + 1];
    const mix = ((u - 0.66) / 0.34) * neighbor;
    out[next.shape] = clamp01((out[next.shape] ?? 0) + next.weight * mix);
  }
  return out;
}

function blinkWeight(dialogue, frame, fps) {
  if (!dialogue?.captions?.length) return 0;
  let weight = 0;
  const half = Math.max(2, Math.round(fps * 0.07));
  for (const caption of dialogue.captions) {
    const last = caption.words.at(-1);
    if (!/[.!?]/.test(last.text)) continue;
    const center = last.endFrame + Math.max(1, Math.round(fps / 30));
    const distance = Math.abs(frame - center);
    if (distance < half) weight = Math.max(weight, Math.cos((distance / half) * (Math.PI / 2)));
  }
  return weight;
}

function addExpression(expressions, name, extra) {
  if (extra <= 0.001) return;
  expressions[name] = clamp01((expressions[name] ?? 0) + extra);
}

/**
 * @param {object} input evaluated clip pose plus the shot signals for one frame
 * @returns {{pose: object, expressions: object, motion: object}}
 */
export function applyReactivity(input) {
  const {
    reactivity, pose, expressions, frame, fps, camera, previousCamera,
    handheldStrength = 0, dialogue = null, dialogueState = null, isSpeaker = false,
    actorIndex = 0, actorCount = 1, shotStart = 0, shotEnd = Number.MAX_SAFE_INTEGER,
  } = input;
  const headWeight = reactivity.head ?? 0.7;
  const torsoWeight = reactivity.torso ?? 0.35;
  const armWeight = reactivity.arm ?? 0.55;
  const expressionWeight = reactivity.expression ?? 0.6;
  const outPose = clonePose(pose);
  let outExpressions = {...expressions};

  let yaw = 0;
  let pitch = 0;
  if (reactivity.look === 'camera' || reactivity.look === 'interest') {
    const from = actorHeadPosition(actorIndex, actorCount);
    const to = reactivity.look === 'camera' ? camera.position : reactivity.interest;
    const angles = lookAngles(from, to);
    yaw = clamp(angles.yaw, -YAW_LIMIT, YAW_LIMIT);
    pitch = clamp(angles.pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  const explicit = episodeTimed(reactivity.beats, shotStart)
    .filter((beat) => beat.frame >= shotStart && beat.frame < shotEnd);
  const beats = reactivity.autoBeats === false ? explicit : [...derivedBeats(dialogue, shotStart, shotEnd), ...explicit];
  const levels = beatLevels(frame, beats);
  const punch = cameraPunch(camera, previousCamera);
  const spoken = isSpeaker ? wordEnergy(dialogueState, frame) : 0;
  const marked = cueLevel(frame, episodeTimed(reactivity.intensityCues, shotStart));
  const handheld = clamp((handheldStrength ?? 0) / 1.5, 0, 1);
  const intensity = clamp01(Math.max(punch, marked, spoken) * 0.92 + handheld * 0.2);

  const lookStrength = clamp01(Math.max(Math.abs(yaw) / YAW_LIMIT, Math.abs(pitch) / PITCH_LIMIT));
  const headFade = headWeight > 0 ? lookStrength : 0;
  const accent = 1 - 0.75 * headFade;
  if (headFade > 0) {
    fadeBone(outPose, 'head', headFade);
    fadeBone(outPose, 'neck', headFade);
  }

  const weights = {head: headWeight, torso: torsoWeight};
  const capYaw = YAW_LIMIT * HEAD_CHANNEL_CAP;
  const capPitch = PITCH_LIMIT * HEAD_CHANNEL_CAP;
  for (const [bone, channel, share] of LOOK_BONES) {
    const nod = (bone === 'head' ? 0.24 * levels.nod : bone === 'neck' ? 0.1 * levels.nod : 0) * accent;
    const lean = (bone === 'head' ? 0.2 * levels.lean : bone === 'chest' ? 0.08 * levels.lean : 0) * accent;
    const bow = (bone === 'chest' || bone === 'spine') ? 0.08 * intensity : 0;
    const pointYaw = bone === 'spine' ? -0.08 * levels.point : 0;
    let boneYaw = yaw * share * weights[channel] + pointYaw * torsoWeight;
    let bonePitch = pitch * share * weights[channel] + (nod + bow) * weights[channel];
    if (bone === 'head' || bone === 'neck') {
      boneYaw = clamp(boneYaw, -capYaw, capYaw);
      bonePitch = clamp(bonePitch, -capPitch, capPitch);
    }
    additiveBone(outPose, bone, boneYaw, bonePitch, lean * weights[channel]);
  }

  const aimRaw = armWeight * armWindow(frame, reactivity.armDelayFrames ?? 0) * levels.point;
  const aim = aimBlend(aimRaw);
  let aimMotion;
  if (aim > 0) {
    const torsoYaw = yaw * TORSO_YAW_SHARE * torsoWeight;
    const direction = pointAimDirection(camera, actorIndex, actorCount, torsoYaw);
    const clipUpper = [...(outPose.rightUpperArm?.rotation ?? REST)];
    const clipLower = [...(outPose.rightLowerArm?.rotation ?? REST)];
    const solved = solveRightArm(direction.map((value) => value * AIM_REACH * (UPPER_ARM + LOWER_ARM)));
    replaceBlend(outPose, 'rightUpperArm', solved.upper, aim);
    replaceBlend(outPose, 'rightLowerArm', solved.lower, aim);
    for (const [bone, rotation] of Object.entries(pointHandRotations())) replaceBlend(outPose, bone, rotation, aim);
    additiveBone(outPose, 'leftUpperArm', 0, 0, 0.18 * aim);
    aimMotion = {direction: [...direction], weight: aim, upper: clipUpper, lower: clipLower};
  }

  if (isSpeaker) outExpressions = tightenMouth(outExpressions, dialogue, frame, expressionWeight, intensity);
  if (expressionWeight > 0) {
    addExpression(outExpressions, 'happy', expressionWeight * 0.45 * levels.nod);
    addExpression(outExpressions, 'surprised', expressionWeight * 0.55 * Math.max(levels.point, punch));
    addExpression(outExpressions, 'relaxed', expressionWeight * 0.35 * levels.lean);
    if (isSpeaker) addExpression(outExpressions, 'blink', expressionWeight * blinkWeight(dialogue, frame, fps));
  }
  // Expression look-at uses blendshapes. Bone look-at avatars have no look*
  // shapes; the stage writes leftEye/rightEye from lookYaw/lookPitch instead.
  if (headWeight > 0) {
    if (yaw > 0) addExpression(outExpressions, 'lookLeft', headWeight * (yaw / YAW_LIMIT));
    if (yaw < 0) addExpression(outExpressions, 'lookRight', headWeight * (-yaw / YAW_LIMIT));
    if (pitch < 0) addExpression(outExpressions, 'lookUp', headWeight * (-pitch / PITCH_LIMIT));
    if (pitch > 0) addExpression(outExpressions, 'lookDown', headWeight * (pitch / PITCH_LIMIT));
  }

  return {
    pose: outPose,
    expressions: outExpressions,
    motion: {
      intensity,
      lookYaw: yaw,
      lookPitch: pitch,
      beat: dominantBeat(levels),
      nod: levels.nod,
      point: levels.point,
      lean: levels.lean,
      ...(aimMotion ? {aim: aimMotion} : {}),
    },
  };
}

function fadeBone(pose, bone, amount) {
  const weight = clamp01(amount);
  const base = pose[bone]?.rotation;
  if (weight <= 0 || !base) return;
  const position = pose[bone].position ? [...pose[bone].position] : [0, 0, 0];
  pose[bone] = {rotation: slerp(base, REST, weight), position};
}

/** Skip optional reactive presets the loaded avatar does not define. Authored names still fail. */
export function resolveExpressionWeights(weights, hasExpression, authored, actorId) {
  const applied = new Map();
  for (const [name, weight] of Object.entries(weights)) {
    const resolved = resolveExpressionName(name, hasExpression);
    if (resolved) applied.set(resolved, weight);
    else if (OPTIONAL_REACTIVE_EXPRESSIONS.has(canonicalExpressionName(name)) && !authored.has(name)) continue;
    else throw new Error(`Avatar ${actorId} has no expression '${name}'`);
  }
  return [...applied];
}

/** Script Studio preset. `off` omits the episode block so older takes stay unchanged. */
export function reactivityPreset(mode = 'off', amount = 1) {
  if (mode === 'off') return null;
  const base = PRESETS[mode];
  if (!base) throw new Error('Unsupported reactivity preset');
  if (!Number.isFinite(amount) || amount < 0 || amount > 1) throw new Error('Reactivity amount must be 0–1');
  const scale = (value) => Math.round(value * amount * 1000) / 1000;
  return {look: base.look, head: scale(base.head), torso: scale(base.torso), arm: scale(base.arm), expression: scale(base.expression)};
}

const LOOKS = new Set(['off', 'camera', 'interest']);
const KINDS = new Set(['nod', 'point', 'lean']);
const fail = (path, message) => { throw new TypeError(`${path}: ${message}`); };
const own = (value, key) => Object.hasOwn(value, key);

function plainObject(value, path, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'expected a plain object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'unsupported field');
  for (const key of required) if (!own(value, key)) fail(`${path}.${key}`, 'required field');
}

function finite(value, path, min, max, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
    fail(path, `expected ${integer ? 'a safe integer' : 'a finite number'} in [${min}, ${max}]`);
  }
}

function vector3(value, path) {
  if (!Array.isArray(value) || value.length !== 3) fail(path, 'expected 3 components');
  value.forEach((entry, index) => finite(entry, `${path}[${index}]`, -100, 100));
}

function timedList(value, path, shotStart, shotEnd, fields, required) {
  if (!Array.isArray(value) || value.length > 48) fail(path, 'expected at most 48 items');
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    plainObject(item, itemPath, fields, required);
    finite(item.frame, `${itemPath}.frame`, shotStart, shotEnd - 1, true);
    if (own(item, 'strength')) finite(item.strength, `${itemPath}.strength`, 0, 1);
    if (own(item, 'intensity')) finite(item.intensity, `${itemPath}.intensity`, 0, 1);
    if (own(item, 'duration')) finite(item.duration, `${itemPath}.duration`, 2, 48, true);
    if (own(item, 'kind') && !KINDS.has(item.kind)) fail(`${itemPath}.kind`, 'unsupported beat');
  });
}

/** Validate one performance's reactivity block. Absent means the clip plays unchanged. */
export function validateReactivity(value, path, {shotDuration, episodeDuration}) {
  plainObject(value, path, [
    'look', 'interest', 'head', 'torso', 'arm', 'expression', 'autoBeats', 'armDelayFrames', 'beats', 'intensityCues',
  ], ['look']);
  if (!LOOKS.has(value.look)) fail(`${path}.look`, 'unsupported look mode');
  if (value.look === 'interest') {
    if (!own(value, 'interest')) fail(`${path}.interest`, 'required field');
    vector3(value.interest, `${path}.interest`);
  } else if (own(value, 'interest')) fail(`${path}.interest`, 'only allowed when look is interest');
  for (const key of ['head', 'torso', 'arm', 'expression']) {
    if (own(value, key)) finite(value[key], `${path}.${key}`, 0, 1);
  }
  if (own(value, 'autoBeats') && typeof value.autoBeats !== 'boolean') fail(`${path}.autoBeats`, 'expected a boolean');
  if (own(value, 'armDelayFrames')) finite(value.armDelayFrames, `${path}.armDelayFrames`, 0, episodeDuration, true);
  if (own(value, 'beats')) timedList(value.beats, `${path}.beats`, 0, shotDuration, ['frame', 'kind', 'strength', 'duration'], ['frame', 'kind']);
  if (own(value, 'intensityCues')) {
    timedList(value.intensityCues, `${path}.intensityCues`, 0, shotDuration, ['frame', 'intensity', 'duration'], ['frame', 'intensity']);
  }
  return value;
}
