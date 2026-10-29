/**
 * Structural, frame-addressed evaluator for narrative-episode/0.1.
 * No asset loading, rendering, wall clock, randomness, or mutation.
 *
 * Time is shot-local. Pose values clamp to the first/last key. A key's easing
 * controls the interval AFTER that key. Missing bones/channels at either end
 * mean rest-relative position [0,0,0] and rotation [0,0,0,1], never hold-last.
 * A renderer must reset the complete humanoid to its normalized rest pose
 * before applying each result: sparse output intentionally omits unused bones.
 * Expressions interpolate linearly; missing names have weight zero. Empty or
 * absent expression tracks yield {} and require resetting expression weights.
 * Assets are opaque actor assetId references, resolved outside this core.
 * Optional performance.reactivity adds look, beat, and expression offsets on
 * top of the clip. Omit it and the pose matches the clip alone.
 */

import {validateDialogue, evaluateDialogueAtFrame} from './dialogue.mjs';
import {validateReactivity, applyReactivity} from './reactive-motion.mjs';

export const EPISODE_SCHEMA = 'narrative-episode/0.1';

const BONES = new Set([
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye', 'jaw',
  ...['left', 'right'].flatMap((side) => [
    'UpperLeg', 'LowerLeg', 'Foot', 'Toes', 'Shoulder', 'UpperArm', 'LowerArm', 'Hand',
    'ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal',
    'IndexProximal', 'IndexIntermediate', 'IndexDistal',
    'MiddleProximal', 'MiddleIntermediate', 'MiddleDistal',
    'RingProximal', 'RingIntermediate', 'RingDistal',
    'LittleProximal', 'LittleIntermediate', 'LittleDistal',
  ].map((part) => side + part)),
]);
const EASINGS = new Set(['linear', 'easeInOutQuad', 'easeOutCubic', 'step']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EXPRESSION = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REST_ROTATION = [0, 0, 0, 1];
const REST_POSITION = [0, 0, 0];
const own = (value, key) => Object.hasOwn(value, key);
const fail = (path, message) => { throw new TypeError(`${path}: ${message}`); };

function object(value, path, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(path, 'expected a plain object');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, 'unsupported field');
  }
  for (const key of required) {
    if (!own(value, key)) fail(`${path}.${key}`, 'required field');
  }
}

function array(value, path, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) {
    fail(path, `expected an array with at least ${minimum} item(s)`);
  }
  // Reject sparse arrays, including data provided directly rather than JSON.
  for (let i = 0; i < value.length; i++) {
    if (!own(value, i)) fail(`${path}[${i}]`, 'missing array item');
  }
}

function number(value, path, min = -Infinity, max = Infinity, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max
      || (integer && !Number.isSafeInteger(value))) {
    fail(path, `expected ${integer ? 'a safe integer' : 'a finite number'} in [${min}, ${max}]`);
  }
}

function id(value, path) {
  if (typeof value !== 'string' || !ID.test(value)) fail(path, 'invalid identifier');
}

function vector(value, length, path, min = -Infinity, max = Infinity) {
  array(value, path);
  if (value.length !== length) fail(path, `expected ${length} components`);
  value.forEach((entry, i) => number(entry, `${path}[${i}]`, min, max));
}

function pose(value, path) {
  object(value, path, Object.keys(value ?? {}), []);
  for (const [bone, transform] of Object.entries(value)) {
    if (!BONES.has(bone)) fail(`${path}.${bone}`, 'unknown normalized VRM humanoid bone');
    object(transform, `${path}.${bone}`, ['position', 'rotation'], []);
    if (!Object.keys(transform).length) fail(`${path}.${bone}`, 'empty bone transform');
    if (own(transform, 'position')) vector(transform.position, 3, `${path}.${bone}.position`);
    if (own(transform, 'rotation')) {
      vector(transform.rotation, 4, `${path}.${bone}.rotation`, -1, 1);
      const length = Math.hypot(...transform.rotation);
      if (Math.abs(length - 1) > 1e-3) {
        fail(`${path}.${bone}.rotation`, 'expected a unit quaternion (tolerance 0.001)');
      }
    }
  }
}

function sequence(value, path) {
  object(value, path, ['duration', 'keyframes']);
  number(value.duration, `${path}.duration`, Number.MIN_VALUE);
  array(value.keyframes, `${path}.keyframes`, 1);
  let previousTime = -Infinity;
  const ids = new Set();
  value.keyframes.forEach((key, i) => {
    const kp = `${path}.keyframes[${i}]`;
    object(key, kp, ['id', 'time', 'pose', 'easing'], ['time', 'pose']);
    number(key.time, `${kp}.time`, 0, value.duration);
    if (key.time <= previousTime) fail(`${kp}.time`, 'keys must be strictly increasing');
    previousTime = key.time;
    if (own(key, 'id')) {
      id(key.id, `${kp}.id`);
      if (ids.has(key.id)) fail(`${kp}.id`, 'duplicate keyframe identifier');
      ids.add(key.id);
    }
    if (own(key, 'easing') && !EASINGS.has(key.easing)) fail(`${kp}.easing`, 'unsupported easing');
    pose(key.pose, `${kp}.pose`);
  });
}

function expressions(value, durationFrames, path) {
  array(value, path);
  let previousFrame = -1;
  value.forEach((key, i) => {
    const kp = `${path}[${i}]`;
    object(key, kp, ['frame', 'values']);
    // A key at the exclusive shot endpoint can define the interpolation target.
    number(key.frame, `${kp}.frame`, 0, durationFrames, true);
    if (key.frame <= previousFrame) fail(`${kp}.frame`, 'keys must be strictly increasing');
    previousFrame = key.frame;
    object(key.values, `${kp}.values`, Object.keys(key.values ?? {}), []);
    for (const [name, weight] of Object.entries(key.values)) {
      if (!EXPRESSION.test(name)) fail(`${kp}.values.${name}`, 'invalid expression name');
      number(weight, `${kp}.values.${name}`, 0, 1);
    }
  });
}

function cameraPose(value, path, fields = ['position', 'target', 'fov']) {
  object(value, path, fields, ['position', 'target', 'fov']);
  vector(value.position, 3, `${path}.position`);
  vector(value.target, 3, `${path}.target`);
  if (value.position.every((v, k) => v === value.target[k])) fail(path, 'position and target must differ');
  number(value.fov, `${path}.fov`, Number.MIN_VALUE, 180 - Number.EPSILON * 180);
}

function cameraMotion(value, durationFrames, base, path) {
  array(value, path, 2);
  if (value.length > 32) fail(path, 'at most 32 camera keys');
  let previousFrame = -1;
  value.forEach((key, i) => {
    const kp = `${path}[${i}]`;
    cameraPose(key, kp, ['frame', 'position', 'target', 'fov', 'easing']);
    number(key.frame, `${kp}.frame`, 0, durationFrames, true);
    if (key.frame <= previousFrame) fail(`${kp}.frame`, 'keys must be strictly increasing');
    previousFrame = key.frame;
    if (own(key, 'easing') && !EASINGS.has(key.easing)) fail(`${kp}.easing`, 'unsupported easing');
  });
  if (value[0].frame !== 0 || value.at(-1).frame !== durationFrames) fail(path, 'camera motion must cover the shot including its exclusive endpoint');
  for (const field of ['position', 'target', 'fov']) {
    if (JSON.stringify(value[0][field]) !== JSON.stringify(base[field])) fail(path, `first camera key must match base ${field}`);
  }
}

/** Validate the complete supported schema; returns its unchanged input. */
export function validateEpisode(episode) {
  object(episode, 'episode', ['schema', 'fps', 'durationFrames', 'actors', 'shots', 'dialogue', 'environment'],
    ['schema', 'fps', 'durationFrames', 'actors', 'shots']);
  if (episode.schema !== EPISODE_SCHEMA) fail('episode.schema', `expected ${EPISODE_SCHEMA}`);
  if (own(episode, 'environment') && !['studio', 'depth-studio'].includes(episode.environment)) fail('episode.environment', 'unsupported environment');
  number(episode.fps, 'episode.fps', 1, 240, true);
  number(episode.durationFrames, 'episode.durationFrames', 1, Number.MAX_SAFE_INTEGER, true);
  array(episode.actors, 'episode.actors', 1);
  const actorIds = new Set();
  episode.actors.forEach((actor, i) => {
    const path = `episode.actors[${i}]`;
    object(actor, path, ['id', 'assetId']);
    id(actor.id, `${path}.id`);
    id(actor.assetId, `${path}.assetId`);
    if (actorIds.has(actor.id)) fail(`${path}.id`, 'duplicate actor');
    actorIds.add(actor.id);
  });
  array(episode.shots, 'episode.shots', 1);
  const shotIds = new Set();
  let expectedStart = 0;
  episode.shots.forEach((shot, i) => {
    const path = `episode.shots[${i}]`;
    object(shot, path, ['id', 'startFrame', 'durationFrames', 'camera', 'performances']);
    id(shot.id, `${path}.id`);
    if (shotIds.has(shot.id)) fail(`${path}.id`, 'duplicate shot');
    shotIds.add(shot.id);
    number(shot.startFrame, `${path}.startFrame`, 0, episode.durationFrames - 1, true);
    number(shot.durationFrames, `${path}.durationFrames`, 1, episode.durationFrames, true);
    if (shot.startFrame !== expectedStart) fail(`${path}.startFrame`, 'shots must be ordered and contiguous (no gaps or overlaps)');
    expectedStart += shot.durationFrames;
    if (expectedStart > episode.durationFrames) fail(path, 'shot exceeds episode duration');
    cameraPose(shot.camera, `${path}.camera`, ['position', 'target', 'fov', 'motion', 'depthOfField', 'handheld']);
    if (own(shot.camera, 'motion')) cameraMotion(shot.camera.motion, shot.durationFrames, shot.camera, `${path}.camera.motion`);
    if (own(shot.camera, 'handheld')) {
      const hp = `${path}.camera.handheld`;
      object(shot.camera.handheld, hp, ['seed', 'strength']);
      number(shot.camera.handheld.seed, `${hp}.seed`, 0, 65535, true);
      number(shot.camera.handheld.strength, `${hp}.strength`, 0, 1.5);
    }
    if (own(shot.camera, 'depthOfField')) {
      const dof = shot.camera.depthOfField, dp = `${path}.camera.depthOfField`;
      object(dof, dp, ['focusDistance', 'aperture', 'maxBlur', 'focusMotion'], ['focusDistance', 'aperture', 'maxBlur']);
      number(dof.focusDistance, `${dp}.focusDistance`, 0.1, 30);
      number(dof.aperture, `${dp}.aperture`, 0, 0.05);
      number(dof.maxBlur, `${dp}.maxBlur`, 0, 0.08);
      if (own(dof, 'focusMotion')) {
        array(dof.focusMotion, `${dp}.focusMotion`, 2);
        if (dof.focusMotion.length > 32) fail(`${dp}.focusMotion`, 'at most 32 focus keys');
        let prior = -1;
        dof.focusMotion.forEach((key, k) => {
          const kp = `${dp}.focusMotion[${k}]`;
          object(key, kp, ['frame', 'focusDistance', 'easing'], ['frame', 'focusDistance']);
          number(key.frame, `${kp}.frame`, 0, shot.durationFrames, true);
          if (key.frame <= prior) fail(`${kp}.frame`, 'keys must be strictly increasing');
          prior = key.frame;
          number(key.focusDistance, `${kp}.focusDistance`, 0.1, 30);
          if (own(key, 'easing') && !EASINGS.has(key.easing)) fail(`${kp}.easing`, 'unsupported easing');
        });
        if (dof.focusMotion[0].frame !== 0 || dof.focusMotion.at(-1).frame !== shot.durationFrames) fail(`${dp}.focusMotion`, 'focus motion must cover the shot including its exclusive endpoint');
        if (dof.focusMotion[0].focusDistance !== dof.focusDistance) fail(`${dp}.focusMotion`, 'first focus key must match focusDistance');
      }
    }
    array(shot.performances, `${path}.performances`);
    const usedActors = new Set();
    shot.performances.forEach((performance, j) => {
      const pp = `${path}.performances[${j}]`;
      object(performance, pp, ['actorId', 'sequence', 'expressions', 'reactivity'], ['actorId', 'sequence']);
      if (!actorIds.has(performance.actorId)) fail(`${pp}.actorId`, 'unknown actor');
      if (usedActors.has(performance.actorId)) fail(`${pp}.actorId`, 'duplicate performance for actor in shot');
      usedActors.add(performance.actorId);
      sequence(performance.sequence, `${pp}.sequence`);
      if (own(performance, 'expressions')) expressions(performance.expressions, shot.durationFrames, `${pp}.expressions`);
      if (own(performance, 'reactivity')) {
        validateReactivity(performance.reactivity, `${pp}.reactivity`, {
          shotStart: shot.startFrame,
          shotDuration: shot.durationFrames,
          episodeDuration: episode.durationFrames,
        });
      }
    });
  });
  if (expectedStart !== episode.durationFrames) fail('episode.shots', 'shots must cover the complete episode');
  if (own(episode, 'dialogue')) {
    validateDialogue(episode.dialogue, {fps: episode.fps, durationFrames: episode.durationFrames, actorIds: [...actorIds]});
    for (const shot of episode.shots) {
      const speaking = episode.dialogue.captions.some((caption) => caption.startFrame < shot.startFrame + shot.durationFrames && caption.endFrame > shot.startFrame);
      if (speaking && !shot.performances.some((p) => p.actorId === episode.dialogue.actorId)) fail('episode.dialogue', `speaker is hidden during shot ${shot.id}`);
    }
  }
  return episode;
}

function interval(keys, time, field) {
  if (time <= keys[0][field]) return [keys[0], keys[0], 0];
  for (let i = 1; i < keys.length; i++) {
    if (time < keys[i][field]) {
      return [keys[i - 1], keys[i], (time - keys[i - 1][field]) / (keys[i][field] - keys[i - 1][field])];
    }
  }
  return [keys.at(-1), keys.at(-1), 0];
}

function ease(value, easing = 'linear') {
  if (easing === 'step') return 0;
  if (easing === 'easeInOutQuad') return value < 0.5 ? 2 * value * value : 1 - 2 * (1 - value) ** 2;
  if (easing === 'easeOutCubic') return 1 - (1 - value) ** 3;
  return value;
}

const lerp = (a, b, t) => a * (1 - t) + b * t;
const normalized = (q) => { const length = Math.hypot(...q); return q.map((v) => v / length); };

function slerp(left, right, t) {
  const a = normalized(left);
  let b = normalized(right);
  let dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  if (dot < 0) { b = b.map((v) => -v); dot = -dot; }
  dot = Math.min(1, dot);
  if (dot > 0.9995) return normalized(a.map((v, i) => lerp(v, b[i], t)));
  const angle = Math.acos(dot);
  const denominator = Math.sin(angle);
  const weightA = Math.sin((1 - t) * angle) / denominator;
  const weightB = Math.sin(t * angle) / denominator;
  return normalized(a.map((v, i) => v * weightA + b[i] * weightB));
}

function evaluatePose(sequence, seconds) {
  const [left, right, fraction] = interval(sequence.keyframes, seconds, 'time');
  const amount = ease(fraction, left.easing);
  const bones = [...new Set(sequence.keyframes.flatMap((key) => Object.keys(key.pose)))].sort();
  return Object.fromEntries(bones.map((bone) => {
    const a = left.pose[bone] ?? {};
    const b = right.pose[bone] ?? {};
    const positionA = a.position ?? REST_POSITION;
    const positionB = b.position ?? REST_POSITION;
    return [bone, {
      rotation: slerp(a.rotation ?? REST_ROTATION, b.rotation ?? REST_ROTATION, amount),
      position: positionA.map((v, i) => lerp(v, positionB[i], amount)),
    }];
  }));
}

function evaluateExpressions(keys, localFrame) {
  if (!keys?.length) return {};
  const [left, right, amount] = interval(keys, localFrame, 'frame');
  const names = [...new Set(keys.flatMap((key) => Object.keys(key.values)))].sort();
  return Object.fromEntries(names.map((name) => [name, lerp(
    own(left.values, name) ? left.values[name] : 0,
    own(right.values, name) ? right.values[name] : 0,
    amount,
  )]));
}

// Smooth seeded value noise, sampled from absolute shot time. Three frequency
// bands give operator sway, correction and fine hand tremor without a live RNG.
function noiseValue(index, seed, channel) {
  let value = (index ^ Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(channel, 0x85ebca6b)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff * 2 - 1;
}
function smoothNoise(time, seed, channel) {
  const index = Math.floor(time), phase = time - index;
  const smooth = phase * phase * (3 - 2 * phase);
  return lerp(noiseValue(index, seed, channel), noiseValue(index + 1, seed, channel), smooth);
}
function handheldNoise(seconds, seed, channel) {
  return 0.55 * smoothNoise(seconds * 0.32, seed, channel)
    + 0.31 * smoothNoise(seconds * 1.18, seed, channel + 10)
    + 0.14 * smoothNoise(seconds * 3.45, seed, channel + 20);
}

function evaluateCamera(camera, localFrame, fps) {
  const [left, right, fraction] = camera.motion
    ? interval(camera.motion, localFrame, 'frame') : [camera, camera, 0];
  const amount = ease(fraction, left.easing);
  const position = left.position.map((v, i) => lerp(v, right.position[i], amount));
  const target = left.target.map((v, i) => lerp(v, right.target[i], amount));
  let rollDegrees;
  if (camera.handheld?.strength) {
    const {seed, strength} = camera.handheld;
    const seconds = localFrame / fps;
    const x = handheldNoise(seconds, seed, 1);
    const y = handheldNoise(seconds, seed, 2);
    const r = handheldNoise(seconds, seed, 3);
    const correctionX = handheldNoise(seconds - 0.19, seed, 4);
    const correctionY = handheldNoise(seconds - 0.23, seed, 5);
    position[0] += 0.023 * strength * x;
    position[1] += 0.014 * strength * y;
    position[2] += 0.006 * strength * r;
    target[0] += strength * (0.009 * x + 0.012 * correctionX);
    target[1] += strength * (0.006 * y + 0.009 * correctionY);
    rollDegrees = 0.60 * strength * r;
  }
  return {
    position,
    target,
    fov: lerp(left.fov, right.fov, amount),
    ...(rollDegrees !== undefined ? {rollDegrees} : {}),
    ...(camera.depthOfField ? {depthOfField: evaluateDepthOfField(camera.depthOfField, localFrame)} : {}),
  };
}

function evaluateDepthOfField(dof, localFrame) {
  const result = {focusDistance:dof.focusDistance, aperture:dof.aperture, maxBlur:dof.maxBlur};
  if (dof.focusMotion) {
    const [left,right,fraction] = interval(dof.focusMotion, localFrame, 'frame');
    result.focusDistance = lerp(left.focusDistance, right.focusDistance, ease(fraction,left.easing));
  }
  return result;
}

/** Frame domain is integer [0, durationFrames). Output owns its own arrays. */
export function evaluateEpisodeAtFrame(episode, frame) {
  validateEpisode(episode);
  return evaluateValidated(episode, frame);
}

/** Validate once and capture owned inputs for production frame evaluation. */
export function compileEpisode(episode) {
  const captured = structuredClone(episode);
  validateEpisode(captured);
  return (frame) => evaluateValidated(captured, frame);
}

function evaluateValidated(episode, frame) {
  number(frame, 'frame', 0, episode.durationFrames - 1, true);
  const shot = episode.shots.find((candidate) => frame < candidate.startFrame + candidate.durationFrames);
  const localFrame = frame - shot.startFrame;
  const seconds = localFrame / episode.fps;
  const dialogue = episode.dialogue ? evaluateDialogueAtFrame(episode.dialogue, frame) : null;
  const camera = evaluateCamera(shot.camera, localFrame, episode.fps);
  const previousCamera = evaluateCamera(shot.camera, Math.max(0, localFrame - 1), episode.fps);
  return {
    schema: EPISODE_SCHEMA,
    frame,
    shotId: shot.id,
    localFrame,
    seconds,
    camera,
    actors: episode.actors.map((actor, actorIndex) => {
      const performance = shot.performances.find((entry) => entry.actorId === actor.id);
      let pose = performance ? evaluatePose(performance.sequence, seconds) : {};
      let expressions = {
        ...(performance ? evaluateExpressions(performance.expressions, localFrame) : {}),
        ...(dialogue && actor.id === episode.dialogue.actorId ? dialogue.mouth : {}),
      };
      let motion;
      if (performance && own(performance, 'reactivity')) {
        const applied = applyReactivity({
          reactivity: performance.reactivity,
          pose,
          expressions,
          frame,
          fps: episode.fps,
          camera,
          previousCamera,
          handheldStrength: shot.camera.handheld?.strength ?? 0,
          dialogue: episode.dialogue ?? null,
          dialogueState: dialogue,
          isSpeaker: Boolean(dialogue && actor.id === episode.dialogue.actorId),
          actorIndex,
          actorCount: episode.actors.length,
          shotStart: shot.startFrame,
          shotEnd: shot.startFrame + shot.durationFrames,
        });
        pose = applied.pose;
        expressions = applied.expressions;
        motion = applied.motion;
      }
      return {
        id: actor.id,
        assetId: actor.assetId,
        pose,
        expressions,
        ...(motion ? {motion} : {}),
      };
    }),
  };
}
