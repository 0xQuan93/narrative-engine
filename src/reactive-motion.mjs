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
 * character's left), the same convention as episode poses. Arm aim is a
 * fixed-iteration CCD solve on a canonical T-pose right arm. It does not read
 * a particular avatar's bone lengths.
 */

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
  ['spine', 'torso', 0.12],
  ['chest', 'torso', 0.2],
  ['upperChest', 'torso', 0.16],
  ['neck', 'head', 0.3],
  ['head', 'head', 0.7],
]);

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

function clampReach(target) {
  const length = hypot3(target);
  const max = UPPER_ARM + LOWER_ARM - 1e-4;
  const min = Math.abs(UPPER_ARM - LOWER_ARM) + 1e-4;
  if (length < 1e-8) return [-max, 0, 0];
  const clamped = Math.min(max, Math.max(min, length));
  const scale = clamped / length;
  return target.map((v) => v * scale);
}

function armForwardKinematics(qUpper, qLower) {
  const upperDir = rotateVector(qUpper, ARM_REST);
  const elbow = upperDir.map((v) => v * UPPER_ARM);
  const lowerDir = rotateVector(mul(qUpper, qLower), ARM_REST);
  const hand = elbow.map((v, i) => v + lowerDir[i] * LOWER_ARM);
  return {elbow, hand};
}

/** Canonical right-arm CCD. `target` is shoulder-local, rest pose points along -X. */
export function solveRightArm(target) {
  const goal = clampReach(target);
  let qUpper = [0, 0, 0, 1];
  let qLower = quatFromAxisAngle([0, 1, 0], 0.55);
  for (let step = 0; step < CCD_STEPS; step += 1) {
    const lower = armForwardKinematics(qUpper, qLower);
    const lowerDelta = fromToQuat(sub(lower.hand, lower.elbow), sub(goal, lower.elbow));
    qLower = normalizeQuat(mul(invertQuat(qUpper), mul(lowerDelta, mul(qUpper, qLower))));
    const upper = armForwardKinematics(qUpper, qLower);
    const upperDelta = fromToQuat(upper.hand, goal);
    qUpper = normalizeQuat(mul(upperDelta, qUpper));
  }
  return {upper: qUpper, lower: qLower, goal};
}

export function rightArmHand(solution) {
  return armForwardKinematics(solution.upper, solution.lower).hand;
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

function shoulderTarget(camera, actorIndex, actorCount) {
  const head = actorHeadPosition(actorIndex, actorCount);
  const shoulder = [head[0] - 0.18, head[1] - 0.18, head[2]];
  const aim = normalize3(sub(camera.position, shoulder));
  const reach = 0.82 * (UPPER_ARM + LOWER_ARM);
  return aim.map((v) => v * reach);
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

  const explicit = (reactivity.beats ?? []).filter((beat) => beat.frame >= shotStart && beat.frame < shotEnd);
  const beats = reactivity.autoBeats === false ? explicit : [...derivedBeats(dialogue, shotStart, shotEnd), ...explicit];
  const levels = beatLevels(frame, beats);
  const punch = cameraPunch(camera, previousCamera);
  const spoken = isSpeaker ? wordEnergy(dialogueState, frame) : 0;
  const marked = cueLevel(frame, reactivity.intensityCues ?? []);
  const handheld = clamp((handheldStrength ?? 0) / 1.5, 0, 1);
  const intensity = clamp01(Math.max(punch, marked, spoken) * 0.92 + handheld * 0.2);

  const weights = {head: headWeight, torso: torsoWeight};
  for (const [bone, channel, share] of LOOK_BONES) {
    const nod = bone === 'head' ? 0.24 * levels.nod : bone === 'neck' ? 0.1 * levels.nod : 0;
    const lean = bone === 'head' ? 0.2 * levels.lean : bone === 'chest' ? 0.08 * levels.lean : 0;
    const bow = (bone === 'chest' || bone === 'spine') ? 0.08 * intensity : 0;
    const pointYaw = bone === 'spine' ? -0.08 * levels.point : 0;
    additiveBone(
      outPose,
      bone,
      yaw * share * weights[channel] + pointYaw * torsoWeight,
      pitch * share * weights[channel] + (nod + bow) * weights[channel],
      lean * weights[channel],
    );
  }

  const aim = armWeight * armWindow(frame, reactivity.armDelayFrames ?? 0) * levels.point;
  if (aim > 0) {
    const solved = solveRightArm(shoulderTarget(camera, actorIndex, actorCount));
    replaceBlend(outPose, 'rightUpperArm', solved.upper, aim);
    replaceBlend(outPose, 'rightLowerArm', solved.lower, aim);
    additiveBone(outPose, 'leftUpperArm', 0, 0, 0.18 * aim);
  }

  if (isSpeaker) outExpressions = tightenMouth(outExpressions, dialogue, frame, expressionWeight, intensity);
  if (expressionWeight > 0) {
    addExpression(outExpressions, 'happy', expressionWeight * 0.45 * levels.nod);
    addExpression(outExpressions, 'surprised', expressionWeight * 0.55 * Math.max(levels.point, punch));
    addExpression(outExpressions, 'relaxed', expressionWeight * 0.35 * levels.lean);
    if (isSpeaker) addExpression(outExpressions, 'blink', expressionWeight * blinkWeight(dialogue, frame, fps));
  }
  // Eye blendshapes follow the same yaw/pitch as the head chain. Eye bones are
  // left on the clip so a rig that has both does not look twice.
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
    },
  };
}

/** Skip optional reactive presets the loaded avatar does not define. Authored names still fail. */
export function resolveExpressionWeights(weights, hasExpression, authored, actorId) {
  const applied = [];
  for (const [name, weight] of Object.entries(weights)) {
    if (hasExpression(name)) applied.push([name, weight]);
    else if (OPTIONAL_REACTIVE_EXPRESSIONS.has(name) && !authored.has(name)) continue;
    else throw new Error(`Avatar ${actorId} has no expression '${name}'`);
  }
  return applied;
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
export function validateReactivity(value, path, {shotStart, shotDuration, episodeDuration}) {
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
  const shotEnd = shotStart + shotDuration;
  if (own(value, 'beats')) timedList(value.beats, `${path}.beats`, shotStart, shotEnd, ['frame', 'kind', 'strength', 'duration'], ['frame', 'kind']);
  if (own(value, 'intensityCues')) {
    timedList(value.intensityCues, `${path}.intensityCues`, shotStart, shotEnd, ['frame', 'intensity', 'duration'], ['frame', 'intensity']);
  }
  return value;
}
