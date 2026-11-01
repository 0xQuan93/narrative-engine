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

test('idle wrap crossfades instead of seeking to the first frame', () => {
  const fixture = studioFixture();
  const episode = createScriptEpisode({
    ...fixture,
    settings: {...DEFAULT_SCRIPT_SETTINGS, text: 'Hello.', motion: 'idle', camera: 'close'},
    minimumSeconds: 8,
  });
  const evaluate = compileEpisode(episode);
  const y = (frame) => evaluate(frame).actors[0].pose.hips.position[1];
  const steps = [];
  for (let frame = 45; frame <= 75; frame += 1) steps.push(Math.abs(y(frame) - y(frame - 1)));
  assert.ok(Math.max(...steps) < 0.05, `wrap step ${Math.max(...steps)}`);
  const sequential = [50, 59, 60, 61, 70].map((frame) => evaluate(frame));
  for (const frame of [70, 60, 50, 61, 59]) {
    assert.deepEqual(evaluate(frame), sequential[[50, 59, 60, 61, 70].indexOf(frame)]);
  }
  const wave = createScriptEpisode({
    ...fixture,
    settings: {...DEFAULT_SCRIPT_SETTINGS, text: 'Hello.', motion: 'wave-idle', camera: 'medium'},
    minimumSeconds: 8,
  });
  const played = compileEpisode(wave);
  const join = Math.floor(fixture.wave.duration * 30);
  const across = [];
  for (let frame = join - 2; frame <= join + 20; frame += 1) {
    const before = played(frame - 1).actors[0].pose.hips.position;
    const after = played(frame).actors[0].pose.hips.position;
    across.push(Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]));
  }
  assert.ok(Math.max(...across) < 0.05, `handoff step ${Math.max(...across)}`);
});

test('idle bake caps a Happy Idle style mid-cycle spike and can keep it', () => {
  const yQuat = (degrees) => {
    const half = degrees * Math.PI / 360;
    return [0, Math.sin(half), 0, Math.cos(half)];
  };
  const fps = 30;
  const frames = 87;
  const angle = (frame, start, count, step) => {
    if (frame < start || frame >= start + count * 2) return 0;
    const into = frame - start + 1;
    return (into <= count ? into : count * 2 - into + 1) * step;
  };
  const idle = {
    duration: frames / fps,
    keyframes: Array.from({length: frames + 1}, (_, frame) => ({
      time: frame / fps,
      easing: 'linear',
      pose: {
        leftUpperArm: {rotation: yQuat(angle(frame, 15, 6, 19))},
        head: {rotation: yQuat(angle(frame, 28, 3, 4.9))},
        hips: {rotation: yQuat(angle(frame, 28, 3, 3))},
      },
    })),
  };
  const step = (left, right) => {
    const dot = Math.min(1, Math.abs(left.reduce((sum, value, index) => sum + value * right[index], 0)));
    return 2 * Math.acos(dot) * 180 / Math.PI;
  };
  const maxBone = (episode, bone) => {
    const evaluate = compileEpisode(episode);
    let max = 0;
    for (let frame = 1; frame < episode.durationFrames; frame += 1) {
      const before = evaluate(frame - 1).actors[0].pose[bone]?.rotation ?? [0, 0, 0, 1];
      const after = evaluate(frame).actors[0].pose[bone]?.rotation ?? [0, 0, 0, 1];
      max = Math.max(max, step(before, after));
    }
    return max;
  };
  const fixture = studioFixture();
  const settings = {...DEFAULT_SCRIPT_SETTINGS, text: 'Hello.', motion: 'idle', camera: 'close'};
  const calmed = createScriptEpisode({...fixture, idle, settings, minimumSeconds: 8});
  assert.ok(maxBone(calmed, 'leftUpperArm') <= 2.05, `arm ${maxBone(calmed, 'leftUpperArm')}`);
  assert.ok(maxBone(calmed, 'head') <= 2.05, `head ${maxBone(calmed, 'head')}`);
  assert.ok(maxBone(calmed, 'hips') <= 2.05, `hips ${maxBone(calmed, 'hips')}`);
  const sequential = compileEpisode(calmed);
  for (const frame of [16, 50, 87 + 16, 87 + 29, 200]) {
    assert.deepEqual(sequential(frame), compileEpisode(calmed)(frame));
  }
  const raw = createScriptEpisode({...fixture, idle, settings: {...settings, idleCalm: false}, minimumSeconds: 8});
  assert.ok(maxBone(raw, 'leftUpperArm') > 15);
  const wave = {
    duration: 1,
    keyframes: [0, 10, 11, 30].map((frame) => ({
      time: frame / fps,
      easing: 'linear',
      pose: {leftUpperArm: {rotation: yQuat(frame >= 11 ? 19 : 0)}},
    })),
  };
  const gestured = createScriptEpisode({
    ...fixture, wave, idle,
    settings: {...settings, motion: 'wave-idle', camera: 'medium'},
    minimumSeconds: 8,
  });
  const gestureStep = step(
    compileEpisode(gestured)(10).actors[0].pose.leftUpperArm.rotation,
    compileEpisode(gestured)(11).actors[0].pose.leftUpperArm.rotation,
  );
  assert.ok(gestureStep > 15, `wave step ${gestureStep}`);
  assert.throws(() => validateScriptSettings({...settings, idleCalm: 'no'}), /Idle calm/);
});
