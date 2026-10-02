import test from 'node:test';
import assert from 'node:assert/strict';
import { createScriptEpisode, DEFAULT_SCRIPT_SETTINGS, validateScriptSettings } from '../src/script-project.mjs';
import { compileEpisode } from '../src/episode.mjs';

export function studioFixture() {
  const camera = { position: [0, 1, 3], target: [0, 1, 0], fov: 30 };
  const wave = { duration: 4.3, keyframes: [{ time: 0, pose: { hips: { position: [0, 0, 0] } }, easing: 'linear' }, { time: 4.3, pose: { hips: { position: [0.43, 0, 0] } }, easing: 'linear' }] };
  const idle = { duration: 2, keyframes: [{ time: 0, pose: { hips: { position: [0, 0, 0] } }, easing: 'linear' }, { time: 2, pose: { hips: { position: [0, 0.2, 0] } }, easing: 'linear' }] };
  const baseEpisode = { schema: 'narrative-episode/0.1', fps: 30, durationFrames: 360, actors: [{ id: 'performer', assetId: 'sample-vrm' }], shots: [0, 1, 2].map((i) => ({ id: `shot-${i}`, startFrame: i * 120, durationFrames: 120, camera, performances: [{ actorId: 'performer', sequence: idle }] })) };
  return { baseEpisode, wave, idle };
}
test('script recipe preserves source cadence and continuous idle across camera cuts', () => {
  const fixture = studioFixture(); const before = JSON.stringify(fixture);
  const episode = createScriptEpisode({ ...fixture, settings: { ...DEFAULT_SCRIPT_SETTINGS, text: 'A short original line.' } });
  assert.equal(episode.durationFrames, 360);
  assert.equal(episode.dialogue.actorId, 'performer');
  const evaluate = compileEpisode(episode);
  assert.ok(Math.abs(evaluate(60).actors[0].pose.hips.position[0] - 0.2) < 1e-6);
  assert.ok(Math.abs(evaluate(150).actors[0].pose.hips.position[1] - 0.07) < 1e-6);
  assert.deepEqual(evaluate(300), evaluate(300));
  assert.equal(JSON.stringify(fixture), before);
});
test('idle and camera presets are explicit; unsupported or excessive settings fail', () => {
  const fixture = studioFixture();
  const episode = createScriptEpisode({ ...fixture, settings: { ...DEFAULT_SCRIPT_SETTINGS, text: 'Hello.', motion: 'idle', camera: 'close' } });
  assert.equal(episode.shots.length, 1);
  assert.ok(Math.abs(compileEpisode(episode)(30).actors[0].pose.hips.position[1] - 0.1) < 1e-6);
  assert.throws(() => validateScriptSettings({ ...DEFAULT_SCRIPT_SETTINGS, arbitraryPath: '/tmp/x' }));
  assert.throws(() => createScriptEpisode({ ...fixture, settings: { ...DEFAULT_SCRIPT_SETTINGS, text: 'word '.repeat(200), wordsPerMinute: 80 } }), /90|long|limit/i);
});
test('short social take keeps three camera beats and holds its final caption', () => {
  const fixture = studioFixture();
  const episode = createScriptEpisode({ ...fixture, settings: { ...DEFAULT_SCRIPT_SETTINGS, text: 'GM. We shipped.' },
    minimumSeconds: 8, holdFinalCaption: true });
  assert.equal(episode.durationFrames, 240);
  assert.equal(episode.shots.length, 3);
  assert.equal(episode.shots[0].startFrame, 0);
  assert.equal(episode.shots.at(-1).startFrame, Math.floor(240 * 0.7));
  assert.equal(episode.dialogue.captions.at(-1).endFrame, 240);
  assert.equal(compileEpisode(episode)(239).shotId, episode.shots.at(-1).id);
  assert.throws(() => createScriptEpisode({ ...fixture, settings: DEFAULT_SCRIPT_SETTINGS, minimumSeconds: 0 }), /minimumSeconds/);
});
test('directed take anchors a delayed push to the selected word with focus and PoseLab motion', () => {
  const fixture = studioFixture();
  const settings = { ...DEFAULT_SCRIPT_SETTINGS, text: 'one '.repeat(30).trim(), motion: 'idle', camera: 'directed',
    format: 'portrait', revealWordIndex: 12 };
  const episode = createScriptEpisode({ ...fixture, settings });
  const words = episode.dialogue.captions.flatMap((caption) => caption.words);
  const camera = episode.shots[0].camera;
  const pushStart = words[12].endFrame + 6;
  const evaluate = compileEpisode(episode);
  assert.equal(episode.environment, 'depth-studio');
  assert.equal(episode.shots.length, 1);
  assert.equal(camera.motion.some((key) => key.frame === pushStart), true);
  assert.equal(camera.depthOfField.focusMotion.length, camera.motion.length);
  assert.ok(evaluate(pushStart + 14).camera.position[2] < evaluate(pushStart).camera.position[2]);
  assert.deepEqual(evaluate(pushStart + 14), evaluate(pushStart + 14));
  assert.ok(Math.abs(evaluate(30).actors[0].pose.hips.position[1] - 0.1) < 1e-6);
  assert.throws(() => createScriptEpisode({ ...fixture, settings: { ...settings, revealWordIndex: 29 } }), /earlier reveal word/);
  assert.throws(() => validateScriptSettings({ ...settings, revealWordIndex: -1 }), /Reveal cue/);
});
test('storyboard sections become editable shots without resetting bank motion', () => {
  const fixture = studioFixture();
  fixture.baseEpisode.shots = fixture.baseEpisode.shots.map((shot, index) => ({...shot,
    camera: {...shot.camera, position: [index, 1, 3], fov: [38, 30, 25][index]}}));
  const settings = { ...DEFAULT_SCRIPT_SETTINGS, text: 'A first scene.\n\nA second scene.\n\nA final scene.',
    motion: 'idle', camera: 'storyboard', shotCameras: ['wide', 'close', 'medium'] };
  const episode = createScriptEpisode({ ...fixture, settings });
  const words = episode.dialogue.captions.flatMap((caption) => caption.words);
  assert.equal(episode.shots.length, 3);
  assert.deepEqual(episode.shots.map((shot) => shot.camera.fov), [38, 25, 30]);
  assert.deepEqual(episode.shots.map((shot) => shot.camera.position), [fixture.baseEpisode.shots[0].camera.position,
    fixture.baseEpisode.shots[2].camera.position, fixture.baseEpisode.shots[1].camera.position]);
  assert.equal(episode.shots[1].startFrame, words[3].startFrame);
  assert.equal(episode.shots[2].startFrame, words[6].startFrame);
  const evaluate = compileEpisode(episode);
  const boundary = episode.shots[1].startFrame;
  assert.equal(evaluate(boundary).shotId, episode.shots[1].id);
  assert.ok(evaluate(boundary).actors[0].pose.hips.position[1] >= evaluate(boundary - 1).actors[0].pose.hips.position[1]);
  assert.throws(() => createScriptEpisode({ ...fixture, settings: { ...settings, text: 'Only one section.' } }), /2–8/);
  assert.throws(() => validateScriptSettings({ ...settings, shotCameras: ['unknown'] }), /Shot cameras/);
});
