import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EPISODE_SCHEMA, evaluateEpisodeAtFrame, validateEpisode } from '../src/episode.mjs';

const sample = JSON.parse(readFileSync(new URL('./fixtures/technical-shot.json', import.meta.url), 'utf8'));
const clone = (value) => structuredClone(value);
const close = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
function fixture() {
  return {
    schema: EPISODE_SCHEMA, fps: 10, durationFrames: 21,
    actors: [{ id: 'a', assetId: 'test-vrm' }],
    shots: [{ id: 'one', startFrame: 0, durationFrames: 21,
      camera: { position: [0, 1, 3], target: [0, 1, 0], fov: 40 },
      performances: [{ actorId: 'a', sequence: { duration: 2, keyframes: [
        { time: 0, pose: { head: { rotation: [0, 0, 0, 1], position: [0, 0, 0] } } },
        { time: 2, pose: { head: { rotation: [0, 1, 0, 0], position: [2, 4, 6] } } },
      ] } }],
    }],
  };
}
const keys = (episode) => episode.shots[0].performances[0].sequence.keyframes;
const head = (episode, frame) => evaluateEpisodeAtFrame(episode, frame).actors[0].pose.head;

test('original six-second recipe validates and repeated/shuffled seeks match sequential results', () => {
  assert.equal(validateEpisode(sample), sample);
  const before = JSON.stringify(sample);
  const sequential = Array.from({ length: 180 }, (_, frame) => evaluateEpisodeAtFrame(sample, frame));
  for (let i = 0; i < 180; i++) {
    const frame = (i * 73) % 180; // Fixed permutation, no random test input.
    assert.deepEqual(evaluateEpisodeAtFrame(sample, frame), sequential[frame]);
    assert.deepEqual(evaluateEpisodeAtFrame(sample, frame), sequential[frame]);
  }
  assert.equal(JSON.stringify(sample), before);
});

test('quaternion shortest-path slerp and linear positions have known midpoint', () => {
  const episode = fixture();
  const result = head(episode, 10);
  close(result.rotation[1], Math.SQRT1_2);
  close(result.rotation[3], Math.SQRT1_2);
  assert.deepEqual(result.position, [1, 2, 3]);
  keys(episode)[1].pose.head.rotation = [0, 0, 0, -1];
  assert.deepEqual(head(episode, 10).rotation, [0, 0, 0, 1]);
});

test('per-left-key easing implements easeInOutQuad and step including exact boundary', () => {
  const episode = fixture();
  keys(episode)[0].easing = 'easeInOutQuad';
  close(head(episode, 5).position[0], 0.25);
  close(head(episode, 15).position[0], 1.75);
  keys(episode)[0].easing = 'step';
  assert.deepEqual(head(episode, 19).position, [0, 0, 0]);
  assert.deepEqual(head(episode, 20).position, [2, 4, 6]);
});

test('poses clamp at first and last keys and single keys hold', () => {
  const episode = fixture();
  keys(episode)[0].time = 0.5;
  keys(episode)[1].time = 1.5;
  assert.deepEqual(head(episode, 0).position, [0, 0, 0]);
  assert.deepEqual(head(episode, 20).position, [2, 4, 6]);
  keys(episode).splice(0, 1);
  assert.deepEqual(head(episode, 0), head(episode, 20));
});

test('missing bones/channels evaluate toward baseline, without holding earlier pose', () => {
  const episode = fixture();
  keys(episode)[1].pose = {};
  keys(episode)[0].pose.head = { position: [2, 0, 0] };
  assert.deepEqual(head(episode, 10), { rotation: [0, 0, 0, 1], position: [1, 0, 0] });
  assert.deepEqual(head(episode, 20), { rotation: [0, 0, 0, 1], position: [0, 0, 0] });
});

test('shots use exclusive endpoints, reset local time, and isolate two actors', () => {
  const episode = fixture();
  episode.durationFrames = 42;
  episode.actors.push({ id: 'b', assetId: 'other-vrm' });
  const second = clone(episode.shots[0]);
  second.id = 'two'; second.startFrame = 21;
  second.performances[0].actorId = 'b';
  second.camera.position = [3, 1, 0];
  episode.shots.push(second);
  const prior = evaluateEpisodeAtFrame(episode, 20);
  const next = evaluateEpisodeAtFrame(episode, 21);
  assert.equal(prior.shotId, 'one');
  assert.equal(next.shotId, 'two');
  assert.equal(next.localFrame, 0);
  assert.equal(next.seconds, 0);
  assert.deepEqual(prior.actors[1].pose, {});
  assert.deepEqual(next.actors[0].pose, {});
  assert.deepEqual(next.actors[1].pose.head.position, [0, 0, 0]);
  assert.deepEqual(next.camera.position, [3, 1, 0]);
});

test('expression keys interpolate, clamp, and default omitted names to zero', () => {
  const episode = fixture();
  episode.shots[0].performances[0].expressions = [
    { frame: 2, values: { happy: 1 } },
    { frame: 12, values: { sad: 0.5 } },
  ];
  const weights = (frame) => evaluateEpisodeAtFrame(episode, frame).actors[0].expressions;
  assert.deepEqual(weights(0), { happy: 1, sad: 0 });
  assert.deepEqual(weights(7), { happy: 0.5, sad: 0.25 });
  assert.deepEqual(weights(20), { happy: 0, sad: 0.5 });
});

test('camera motion and depth settings evaluate from absolute local frames', () => {
  const episode = fixture();
  const camera = episode.shots[0].camera;
  camera.motion = [
    {frame: 0, position: [0, 1, 3], target: [0, 1, 0], fov: 40, easing: 'easeInOutQuad'},
    {frame: 20, position: [0.2, 1.1, 2.4], target: [0, 1.2, 0], fov: 35, easing: 'step'},
    {frame: 21, position: [0.2, 1.1, 2.4], target: [0, 1.2, 0], fov: 35},
  ];
  camera.depthOfField = {focusDistance: 2.5, aperture: 0.002, maxBlur: 0.004};
  const result = (frame) => evaluateEpisodeAtFrame(episode, frame).camera;
  assert.deepEqual(result(0).position, [0, 1, 3]);
  assert.deepEqual(result(10).position, [0.1, 1.05, 2.7]);
  close(result(10).fov, 37.5);
  assert.deepEqual(result(20).position, [0.2, 1.1, 2.4]);
  const before = JSON.stringify(episode);
  for (const frame of [20, 1, 10, 20, 0, 19]) assert.deepEqual(result(frame), evaluateEpisodeAtFrame(episode, frame).camera);
  result(10).depthOfField.focusDistance = 99;
  assert.equal(JSON.stringify(episode), before);
});

test('camera paths require full coverage, valid pose, and bounded depth controls', () => {
  const withMotion = () => {
    const episode = fixture();
    episode.shots[0].camera.motion = [
      {frame: 0, position: [0, 1, 3], target: [0, 1, 0], fov: 40},
      {frame: 21, position: [0, 1, 2], target: [0, 1, 0], fov: 35},
    ];
    return episode;
  };
  const bad = [
    [e => { e.shots[0].camera.motion[0].frame = 1; }, /cover the shot/],
    [e => { e.shots[0].camera.motion[1].frame = 20; }, /exclusive endpoint/],
    [e => { e.shots[0].camera.motion[1].frame = 0; }, /strictly increasing/],
    [e => { e.shots[0].camera.motion[0].position[0] = 1; }, /must match base position/],
    [e => { e.shots[0].camera.motion[1].target = [0, 1, 2]; }, /position and target must differ/],
    [e => { e.shots[0].camera.motion[1].easing = 'spring'; }, /unsupported easing/],
    [e => { e.shots[0].camera.depthOfField = {focusDistance: 2, aperture: 0.2, maxBlur: 0.004}; }, /aperture/],
  ];
  for (const [change, pattern] of bad) { const episode = withMotion(); change(episode); assert.throws(() => validateEpisode(episode), pattern); }
});

test('handheld camera motion is bounded, seeded, and independent of seek order', () => {
  const episode = fixture();
  episode.environment = 'depth-studio';
  episode.shots[0].camera.handheld = {seed: 42, strength: 1};
  episode.shots[0].camera.depthOfField = {focusDistance: 3, aperture: 0.035, maxBlur: 0.055};
  const frames = Array.from({length: 21}, (_, frame) => evaluateEpisodeAtFrame(episode, frame).camera);
  assert.ok(frames.some((camera, frame) => frame > 0 && Math.abs(camera.position[0] - frames[0].position[0]) > 0.001));
  assert.ok(frames.some((camera) => Math.abs(camera.rollDegrees) > 0.01));
  assert.ok(frames.every((camera) => Math.abs(camera.rollDegrees) <= 0.60));
  for (const frame of [20, 4, 17, 0, 10, 4, 20]) assert.deepEqual(evaluateEpisodeAtFrame(episode, frame).camera, frames[frame]);
  const other = clone(episode); other.shots[0].camera.handheld.seed = 43;
  assert.notDeepEqual(evaluateEpisodeAtFrame(other, 10).camera.position, frames[10].position);
  episode.shots[0].camera.handheld.strength = 0;
  assert.deepEqual(evaluateEpisodeAtFrame(episode, 10).camera.position, [0, 1, 3]);
});

test('handheld controls and depth-studio environment reject malformed values', () => {
  for (const [field, change] of [
    ['environment', e => {e.environment = 'unknown';}],
    ['seed', e => {e.shots[0].camera.handheld = {seed: -1, strength: 1};}],
    ['strength', e => {e.shots[0].camera.handheld = {seed: 1, strength: 2};}],
    ['unsupported field', e => {e.shots[0].camera.handheld = {seed: 1, strength: 1, random: true};}],
  ]) {
    const episode = fixture(); change(episode);
    assert.throws(() => validateEpisode(episode), new RegExp(field));
  }
});

test('focus pull evaluates at absolute frames and validates shot coverage', () => {
  const episode = fixture();
  const dof = {focusDistance:4,aperture:0.04,maxBlur:0.06,focusMotion:[
    {frame:0,focusDistance:4,easing:'step'},
    {frame:5,focusDistance:4,easing:'easeInOutQuad'},
    {frame:15,focusDistance:2,easing:'step'},
    {frame:21,focusDistance:2},
  ]};
  episode.shots[0].camera.depthOfField=dof;
  const focus=frame=>evaluateEpisodeAtFrame(episode,frame).camera.depthOfField.focusDistance;
  close(focus(0),4); close(focus(10),3); close(focus(15),2); close(focus(20),2);
  const expected = new Map([[0,4],[3,4],[10,3],[15,2],[20,2]]);
  for(const frame of [20,3,10,0,15,10])close(focus(frame),expected.get(frame));
  const bad=clone(episode);bad.shots[0].camera.depthOfField.focusMotion[0].focusDistance=3;
  assert.throws(()=>validateEpisode(bad),/first focus key/);
  bad.shots[0].camera.depthOfField.focusMotion[0].focusDistance=4;
  bad.shots[0].camera.depthOfField.focusMotion.at(-1).frame=20;
  assert.throws(()=>validateEpisode(bad),/exclusive endpoint/);
});

test('returned arrays are independent from input and subsequent results', () => {
  const episode = fixture();
  const before = clone(episode);
  const first = evaluateEpisodeAtFrame(episode, 10);
  first.camera.position[0] = 999;
  first.actors[0].pose.head.position[0] = 999;
  first.actors[0].pose.head.rotation[0] = 999;
  assert.deepEqual(episode, before);
  assert.equal(head(episode, 10).position[0], 1);
});

test('custom expression names never read inherited object properties', () => {
  const episode = fixture();
  episode.shots[0].performances[0].expressions = [
    { frame: 0, values: { constructor: 1 } },
    { frame: 20, values: { toString: 0.8 } },
  ];
  assert.deepEqual(evaluateEpisodeAtFrame(episode, 10).actors[0].expressions, {
    constructor: 0.5, toString: 0.4,
  });
});

test('invalid recipes and unsupported fields fail explicitly', () => {
  const cases = [
    ['schema', (e) => { e.schema = 'future'; }],
    ['unsupported field', (e) => { e.seed = 7; }],
    ['fps', (e) => { e.fps = 29.97; }],
    ['fps', (e) => { e.fps = 241; }],
    ['durationFrames', (e) => { e.durationFrames = 0; }],
    ['actors', (e) => { e.actors = []; }],
    ['duplicate actor', (e) => { e.actors.push(clone(e.actors[0])); }],
    ['unknown actor', (e) => { e.shots[0].performances[0].actorId = 'missing'; }],
    ['duplicate performance', (e) => { e.shots[0].performances.push(clone(e.shots[0].performances[0])); }],
    ['shots', (e) => { e.shots = []; }],
    ['contiguous', (e) => { e.shots[0].startFrame = 1; }],
    ['complete episode', (e) => { e.shots[0].durationFrames = 20; }],
    ['fov', (e) => { e.shots[0].camera.fov = 180; }],
    ['position and target', (e) => { e.shots[0].camera.target = [...e.shots[0].camera.position]; }],
    ['keyframes', (e) => { keys(e).splice(0); }],
    ['strictly increasing', (e) => { keys(e)[1].time = 0; }],
    ['time', (e) => { keys(e)[1].time = 3; }],
    ['unknown normalized', (e) => { keys(e)[0].pose = { fakeBone: { rotation: [0, 0, 0, 1] } }; }],
    ['empty bone transform', (e) => { keys(e)[0].pose.head = {}; }],
    ['unit quaternion', (e) => { keys(e)[0].pose.head.rotation = [0, 0, 0, 0]; }],
    ['rotation', (e) => { keys(e)[0].pose.head.rotation = [0, NaN, 0, 1]; }],
    ['position', (e) => { keys(e)[0].pose.head.position[0] = Infinity; }],
    ['unsupported easing', (e) => { keys(e)[0].easing = 'bounce'; }],
    ['unsupported field', (e) => { keys(e)[0].pose.head.scale = [1, 1, 1]; }],
    ['frame', (e) => { e.shots[0].performances[0].expressions = [{ frame: 0.5, values: {} }]; }],
    ['happy', (e) => { e.shots[0].performances[0].expressions = [{ frame: 0, values: { happy: 2 } }]; }],
  ];
  for (const [message, change] of cases) {
    const episode = fixture(); change(episode);
    assert.throws(() => validateEpisode(episode), new RegExp(message));
  }
  for (const bad of [null, [], 'episode']) assert.throws(() => validateEpisode(bad), /plain object/);
});

test('overlapping shots and noninteger/out-of-range frame requests fail', () => {
  const episode = fixture();
  episode.durationFrames = 42;
  const second = clone(episode.shots[0]); second.id = 'two'; second.startFrame = 20;
  episode.shots.push(second);
  assert.throws(() => validateEpisode(episode), /contiguous/);
  for (const frame of [-1, 21, 0.5, NaN, Infinity, '1']) {
    assert.throws(() => evaluateEpisodeAtFrame(fixture(), frame), /frame/);
  }
});
