import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDialogue} from '../src/dialogue.mjs';
import {compileEpisode, evaluateEpisodeAtFrame, validateEpisode, EPISODE_SCHEMA} from '../src/episode.mjs';
import {createScriptEpisode, DEFAULT_SCRIPT_SETTINGS, validateScriptSettings} from '../src/script-project.mjs';
import {studioFixture} from './script-project.test.mjs';
import {
  applyReactivity, lookAngles, quatYXZ, resolveExpressionWeights, rightArmHand, rotateVector, solveRightArm,
} from '../src/reactive-motion.mjs';

const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v) => {
  const length = Math.hypot(...v);
  return v.map((entry) => entry / length);
};

function episode(mutate) {
  const value = {
    schema: EPISODE_SCHEMA, fps: 30, durationFrames: 60,
    actors: [{id: 'a', assetId: 'synthetic'}],
    shots: [{
      id: 'shot', startFrame: 0, durationFrames: 60,
      camera: {position: [0, 1.5, 3], target: [0, 1.4, 0], fov: 32},
      performances: [{
        actorId: 'a',
        sequence: {duration: 2, keyframes: [
          {time: 0, pose: {hips: {position: [0, 0, 0]}, rightUpperArm: {rotation: [0, 0, -0.259, 0.966]}}},
          {time: 2, pose: {hips: {position: [0.2, 0, 0]}, rightUpperArm: {rotation: [0, 0, -0.259, 0.966]}}},
        ]},
      }],
    }],
  };
  mutate?.(value);
  return value;
}

test('look quaternion sends +Z toward the target', () => {
  const from = [0, 1.5, 0.02];
  const targets = [[0, 1.5, 3], [1.4, 1.5, 2], [-0.8, 2.4, 1.6], [0.2, 0.4, 2]];
  for (const to of targets) {
    const {yaw, pitch} = lookAngles(from, to);
    const forward = rotateVector(quatYXZ(yaw, pitch, 0), [0, 0, 1]);
    const direction = unit([to[0] - from[0], to[1] - from[1], to[2] - from[2]]);
    assert.ok(dot(unit(forward), direction) > 0.999, `look missed ${to}`);
  }
  assert.ok(lookAngles([0, 1.5, 0], [1, 1.5, 2]).yaw > 0);
  assert.ok(lookAngles([0, 1.5, 0], [0, 3, 2]).pitch < 0);
});

test('canonical right-arm CCD reaches the same target every time', () => {
  const target = [0.04, 0.1, 0.4];
  const first = solveRightArm(target);
  const error = Math.hypot(...rightArmHand(first).map((value, index) => value - first.goal[index]));
  assert.ok(error < 0.02, `hand error ${error}`);
  for (let i = 0; i < 5; i += 1) assert.deepEqual(solveRightArm(target), first);
  const alongRest = solveRightArm([-0.45, 0, 0.02]);
  assert.ok(1 - Math.abs(first.upper[3]) > 1 - Math.abs(alongRest.upper[3]));
});

test('point aim blends onto the clip instead of replacing it', () => {
  const pose = {
    hips: {position: [0.2, 0, 0], rotation: [0, 0, 0, 1]},
    rightUpperArm: {rotation: [0, 0, -0.259, 0.966], position: [0, 0, 0]},
    rightLowerArm: {rotation: [0, 0.383, 0, 0.924], position: [0, 0, 0]},
  };
  const before = structuredClone(pose);
  const camera = {position: [0.2, 1.4, 2.2], target: [0, 1.4, 0], fov: 30};
  const applied = applyReactivity({
    reactivity: {look: 'off', head: 0, torso: 0, arm: 0.5, expression: 0, autoBeats: false,
      beats: [{frame: 8, kind: 'point', strength: 1, duration: 16}]},
    pose, expressions: {happy: 0.25}, frame: 16, fps: 30, camera, previousCamera: camera,
    actorIndex: 0, actorCount: 1, shotStart: 0, shotEnd: 40,
  });
  assert.deepEqual(pose, before);
  assert.equal(applied.expressions.happy, 0.25);
  assert.deepEqual(applied.pose.hips, pose.hips);
  const base = pose.rightUpperArm.rotation;
  const next = applied.pose.rightUpperArm.rotation;
  const qdot = (a, b) => Math.abs(a.reduce((sum, value, index) => sum + value * b[index], 0));
  assert.ok(qdot(base, next) < 0.999);
  assert.ok(qdot(base, next) > 0.9);
  assert.equal(applied.motion.beat, 'point');
  assert.deepEqual(applyReactivity({
    reactivity: {look: 'off', head: 0, torso: 0, arm: 0.5, expression: 0, autoBeats: false,
      beats: [{frame: 8, kind: 'point', strength: 1, duration: 16}]},
    pose: before, expressions: {happy: 0.25}, frame: 16, fps: 30, camera, previousCamera: camera,
    actorIndex: 0, actorCount: 1, shotStart: 0, shotEnd: 40,
  }), applied);
});

test('optional reactive expressions are skipped and authored names are not', () => {
  const available = new Set(['aa', 'happy']);
  assert.deepEqual(resolveExpressionWeights(
    {aa: 0.4, happy: 0.2, lookLeft: 0.5, blink: 1},
    (name) => available.has(name),
    new Set(),
    'a',
  ), [['aa', 0.4], ['happy', 0.2]]);
  assert.throws(() => resolveExpressionWeights({happy: 0.2}, () => false, new Set(['happy']), 'a'), /happy/);
  assert.throws(() => resolveExpressionWeights({aa: 1}, () => false, new Set(), 'a'), /aa/);
});

test('reactivity is seek-stable and absent blocks match the clip', () => {
  const plain = episode();
  const reactive = episode((value) => {
    value.dialogue = compileDialogue({text: 'Hi. Wow!', actorId: 'a', fps: 30, wordsPerMinute: 160, mouthStrength: 0.7});
    value.shots[0].camera.motion = [
      {frame: 0, position: [0, 1.5, 3], target: [0, 1.4, 0], fov: 32, easing: 'easeOutCubic'},
      {frame: 24, position: [0.35, 1.55, 2.4], target: [0, 1.45, 0], fov: 28},
      {frame: 60, position: [0.35, 1.55, 2.4], target: [0, 1.45, 0], fov: 28},
    ];
    value.shots[0].performances[0].reactivity = {
      look: 'camera', head: 0.8, torso: 0.4, arm: 0.6, expression: 0.7,
      intensityCues: [{frame: 30, intensity: 1, duration: 10}],
    };
  });
  const straight = episode((value) => {
    value.shots[0].performances[0].reactivity = {look: 'off', head: 0, torso: 0, arm: 0, expression: 0, autoBeats: false};
  });
  validateEpisode(reactive);
  const sequential = Array.from({length: 60}, (_, frame) => evaluateEpisodeAtFrame(reactive, frame));
  const order = [...sequential.keys()].reverse().filter((_, index) => index % 2 === 0)
    .concat(sequential.map((_, index) => index).filter((index) => index % 2 === 1));
  for (const frame of order) assert.deepEqual(evaluateEpisodeAtFrame(reactive, frame), sequential[frame]);
  assert.equal(evaluateEpisodeAtFrame(plain, 10).actors[0].motion, undefined);
  assert.deepEqual(evaluateEpisodeAtFrame(straight, 10).actors[0].pose, evaluateEpisodeAtFrame(plain, 10).actors[0].pose);
  assert.deepEqual(evaluateEpisodeAtFrame(straight, 10).actors[0].expressions, evaluateEpisodeAtFrame(plain, 10).actors[0].expressions);
  assert.ok(sequential.some((state) => state.actors[0].motion.beat === 'nod'));
  assert.ok(sequential.some((state) => state.actors[0].motion.beat === 'point'));
  assert.ok(sequential[20].actors[0].pose.head);
  assert.ok(sequential[34].actors[0].motion.intensity > sequential[52].actors[0].motion.intensity);
  const side = episode((value) => {
    value.shots[0].camera.position = [1.6, 1.5, 1.2];
    value.shots[0].performances[0].reactivity = {look: 'camera', head: 1, torso: 0, arm: 0, expression: 0, autoBeats: false};
  });
  const interest = episode((value) => {
    value.shots[0].performances[0].reactivity = {
      look: 'interest', interest: [-1.2, 1.5, 1.2], head: 1, torso: 0, arm: 0, expression: 0, autoBeats: false,
    };
  });
  assert.ok(evaluateEpisodeAtFrame(side, 8).actors[0].motion.lookYaw > 0.2);
  assert.ok(evaluateEpisodeAtFrame(interest, 8).actors[0].motion.lookYaw < -0.2);
  assert.notDeepEqual(evaluateEpisodeAtFrame(side, 8).actors[0].pose.head.rotation, evaluateEpisodeAtFrame(interest, 8).actors[0].pose.head.rotation);
  const first = evaluateEpisodeAtFrame(reactive, 21);
  first.actors[0].pose.head.rotation[0] = 3;
  first.actors[0].expressions.aa = 3;
  assert.deepEqual(evaluateEpisodeAtFrame(reactive, 21), sequential[21]);
});

test('mouth coupling keeps zero expression identical and tightens a vowel when enabled', () => {
  const dialogue = compileDialogue({text: 'alpha omega.', actorId: 'a', fps: 30, wordsPerMinute: 120, mouthStrength: 0.8});
  const base = episode((value) => { value.dialogue = dialogue; });
  const quiet = episode((value) => {
    value.dialogue = dialogue;
    value.shots[0].performances[0].reactivity = {look: 'off', head: 0, torso: 0, arm: 0, expression: 0, autoBeats: false};
  });
  const shaped = episode((value) => {
    value.dialogue = dialogue;
    value.shots[0].camera.position = [0, 1.5, 3];
    value.shots[0].performances[0].reactivity = {look: 'off', head: 0, torso: 0, arm: 0, expression: 1, autoBeats: false};
  });
  const sample = compileEpisode(base);
  const quietEval = compileEpisode(quiet);
  const shapedEval = compileEpisode(shaped);
  for (const frame of [0, 7, 15, 28, 40]) {
    assert.deepEqual(quietEval(frame).actors[0].expressions, sample(frame).actors[0].expressions);
    assert.deepEqual(quietEval(frame), quietEval(frame));
  }
  const changed = dialogue.mouthCues.some((cue) => {
    const frame = cue.startFrame;
    const left = sample(frame).actors[0].expressions;
    const right = shapedEval(frame).actors[0].expressions;
    return left[cue.shape] !== right[cue.shape];
  });
  assert.equal(changed, true);
  const blended = dialogue.mouthCues.some((cue, index) => {
    if (index === 0) return false;
    const previous = dialogue.mouthCues[index - 1];
    if (cue.startFrame - previous.endFrame > 3) return false;
    const frame = cue.startFrame;
    const weights = shapedEval(frame).actors[0].expressions;
    return weights[previous.shape] > 0 && weights[cue.shape] > 0;
  });
  assert.equal(blended, true);
  const end = dialogue.captions.at(-1).words.at(-1).endFrame + 1;
  assert.ok(shapedEval(Math.min(end, 59)).actors[0].expressions.blink > 0);
});

test('malformed reactivity is rejected and does not disturb the source episode', () => {
  const bad = [
    [(value) => { value.shots[0].performances[0].reactivity = {look: 'spring'}; }, /look/],
    [(value) => { value.shots[0].performances[0].reactivity = {look: 'camera', spring: true}; }, /spring/],
    [(value) => { value.shots[0].performances[0].reactivity = {look: 'interest'}; }, /interest/],
    [(value) => { value.shots[0].performances[0].reactivity = {look: 'camera', beats: [{frame: 0, kind: 'wave'}]}; }, /beat/],
    [(value) => { value.shots[0].performances[0].reactivity = {look: 'camera', beats: [{frame: 90, kind: 'nod'}]}; }, /frame/],
    [(value) => { value.shots[0].performances[0].reactivity = {look: 'camera', head: 2}; }, /head/],
  ];
  for (const [change, pattern] of bad) assert.throws(() => validateEpisode(episode(change)), pattern);
  assert.throws(() => validateScriptSettings({...DEFAULT_SCRIPT_SETTINGS, reactivity: 'physics'}), /reactivity preset/);
  assert.throws(() => validateScriptSettings({...DEFAULT_SCRIPT_SETTINGS, reactivityAmount: 1.2}), /Reactivity amount/);
});

test('Script Studio still defaults to the clip and can opt into lively offsets', () => {
  const fixture = studioFixture();
  const before = JSON.stringify(fixture);
  const text = 'Hello there. A second line!';
  const still = createScriptEpisode({...fixture, settings: {...DEFAULT_SCRIPT_SETTINGS, text, motion: 'idle', reactivity: 'off'}});
  const lively = createScriptEpisode({...fixture, settings: {...DEFAULT_SCRIPT_SETTINGS, text, motion: 'idle', reactivity: 'lively', reactivityAmount: 0.5}});
  assert.equal(still.shots[0].performances[0].reactivity, undefined);
  assert.equal(lively.shots[0].performances[0].reactivity.look, 'camera');
  close(lively.shots[0].performances[0].reactivity.head, 0.39);
  assert.equal(lively.shots[0].performances[0].reactivity.armDelayFrames, undefined);
  const stillFrame = compileEpisode(still)(90);
  const liveFrame = compileEpisode(lively)(90);
  close(stillFrame.actors[0].pose.hips.position[1], liveFrame.actors[0].pose.hips.position[1]);
  assert.equal(stillFrame.actors[0].pose.head, undefined);
  assert.ok(liveFrame.actors[0].pose.head);
  assert.deepEqual(liveFrame, compileEpisode(lively)(90));
  const legacy = createScriptEpisode({...fixture, settings: {text, wordsPerMinute: 150, mouthStrength: 0.7, motion: 'idle', camera: 'medium'}});
  assert.equal(legacy.shots[0].performances[0].reactivity, undefined);
  const directed = createScriptEpisode({...fixture, settings: {
    ...DEFAULT_SCRIPT_SETTINGS, text: 'one '.repeat(30).trim(), motion: 'idle', camera: 'directed', reactivity: 'subtle', revealWordIndex: 12,
  }});
  const push = directed.dialogue.captions.flatMap((caption) => caption.words)[12].endFrame + 6;
  assert.equal(directed.shots[0].performances[0].reactivity.beats[0].frame, push);
  assert.equal(directed.shots[0].performances[0].reactivity.beats[0].kind, 'point');
  const atPush = compileEpisode(directed)(Math.min(push + 4, directed.durationFrames - 1));
  assert.equal(atPush.actors[0].motion.beat, 'point');
  assert.ok(atPush.actors[0].pose.rightUpperArm);
  assert.equal(JSON.stringify(fixture), before);
});
