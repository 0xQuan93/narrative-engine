import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileDialogue} from '../src/dialogue.mjs';
import {compileEpisode, evaluateEpisodeAtFrame, EPISODE_SCHEMA, validateEpisode} from '../src/episode.mjs';
import {sampleBody, sampleGroove, selectGrooveBeats} from '../src/music.mjs';
import {combineRotations, rotateVector} from '../src/reactive-motion.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const pitchOf = (q) => {
  const forward = rotateVector(q, [0, 0, 1]);
  return -Math.atan2(forward[1], Math.hypot(forward[0], forward[2]));
};
const rollOf = (q) => {
  const up = rotateVector(q, [0, 1, 0]);
  return Math.atan2(up[0], up[1]);
};

function restEpisode(mutate, duration = 180) {
  const episode = {
    schema: EPISODE_SCHEMA, fps: 30, durationFrames: duration,
    actors: [{id: 'a', assetId: 'synthetic'}],
    shots: [{
      id: 'shot', startFrame: 0, durationFrames: duration,
      camera: {position: [0, 1.5, 2.4], target: [0, 1.5, 0], fov: 28},
      performances: [{
        actorId: 'a',
        sequence: {duration: duration / 30, keyframes: [{time: 0, pose: {}}, {time: duration / 30, pose: {}}]},
        reactivity: {look: 'off', head: 0, torso: 0, arm: 0, expression: 0, autoBeats: false},
      }],
    }],
  };
  mutate?.(episode);
  return episode;
}

function baselineEpisode() {
  const dialogue = compileDialogue({text: 'Hi. Wow!', actorId: 'a', fps: 30, wordsPerMinute: 160, mouthStrength: 0.7});
  return {
    schema: EPISODE_SCHEMA, fps: 30, durationFrames: 60,
    actors: [{id: 'a', assetId: 'synthetic'}],
    shots: [{
      id: 'shot', startFrame: 0, durationFrames: 60,
      camera: {position: [0, 1.5, 3], target: [0, 1.4, 0], fov: 32},
      performances: [{
        actorId: 'a',
        sequence: {duration: 2, keyframes: [
          {time: 0, pose: {hips: {position: [0, 0, 0]}}},
          {time: 2, pose: {hips: {position: [0.2, 0, 0]}}},
        ]},
        reactivity: {
          look: 'camera', head: 0.8, torso: 0.4, arm: 0.2, expression: 0.7,
          beats: [{frame: 10, kind: 'nod', strength: 1, duration: 12}],
          intensityCues: [{frame: 30, intensity: 1, duration: 10}],
        },
      }],
    }],
    dialogue,
  };
}

function argmax(episode, from, to, read) {
  let best = -Infinity;
  let frame = from;
  for (let cursor = from; cursor <= to; cursor += 1) {
    const value = read(evaluateEpisodeAtFrame(episode, cursor).actors[0]);
    if (value > best) {
      best = value;
      frame = cursor;
    }
  }
  return frame;
}

test('episodes without music life blocks match the pre-change reactive frames', () => {
  const expected = JSON.parse(readFileSync(new URL('./fixtures/reactive-baseline.json', import.meta.url), 'utf8'));
  const episode = baselineEpisode();
  validateEpisode(episode);
  for (const [frame, actor] of Object.entries(expected.frames)) {
    const actorState = evaluateEpisodeAtFrame(episode, Number(frame)).actors[0];
    assert.deepEqual(JSON.parse(JSON.stringify(actorState)), actor);
  }
  const technical = JSON.parse(readFileSync(new URL('./fixtures/technical-shot.json', import.meta.url), 'utf8'));
  assert.equal(evaluateEpisodeAtFrame(technical, 45).actors[0].expressions.happy, 0.4);
  assert.equal(evaluateEpisodeAtFrame(technical, 45).actors[0].motion, undefined);
  const legacy = evaluateEpisodeAtFrame(episode, 16).actors[0];
  assert.equal(legacy.motion.nod, 1);
  assert.ok(legacy.expressions.happy > 0.3);
  assert.equal(evaluateEpisodeAtFrame(episode, 0).actors[0].expressions.blink, undefined);
});

test('a music timeline alone does not move an otherwise unchanged performance', () => {
  const plain = restEpisode();
  const marked = restEpisode((episode) => {
    episode.music = {bpm: 120, beats: [{frame: 10, strength: 1, downbeat: true}, {frame: 40, strength: 0.4, downbeat: false}]};
  });
  validateEpisode(marked);
  for (const frame of [0, 10, 20, 40]) {
    assert.deepEqual(evaluateEpisodeAtFrame(marked, frame).actors[0], evaluateEpisodeAtFrame(plain, frame).actors[0]);
  }
});

test('silent takes blink only when eyes are enabled, on a seeded asymmetric cadence', () => {
  const eyes = {blinkRate: 16, saccade: 0, seed: 1};
  const episode = restEpisode((value) => {
    value.durationFrames = 600;
    value.shots[0].durationFrames = 600;
    value.shots[0].performances[0].sequence = {duration: 20, keyframes: [{time: 0, pose: {}}, {time: 20, pose: {}}]};
    value.shots[0].performances[0].reactivity = {look: 'off', head: 0, torso: 0, arm: 0, expression: 0, autoBeats: false, eyes};
  }, 600);
  const other = structuredClone(episode);
  other.shots[0].performances[0].reactivity.eyes = {...eyes, seed: 2};
  const silent = restEpisode((value) => {
    value.durationFrames = 600;
    value.shots[0].durationFrames = 600;
    value.shots[0].performances[0].sequence = {duration: 20, keyframes: [{time: 0, pose: {}}, {time: 20, pose: {}}]};
    value.shots[0].performances[0].reactivity = {look: 'camera', head: 0.8, torso: 0.4, arm: 0, expression: 0.8, autoBeats: false};
  }, 600);
  validateEpisode(episode);
  const weights = [];
  let peaks = [];
  let previous = 0;
  for (let frame = 0; frame < 600; frame += 1) {
    const blink = evaluateEpisodeAtFrame(episode, frame).actors[0].expressions.blink ?? 0;
    weights.push(blink);
    if (blink > 0.6 && previous <= 0.6) peaks.push(frame);
    previous = blink;
    assert.equal(evaluateEpisodeAtFrame(silent, frame).actors[0].expressions.blink ?? 0, 0);
  }
  assert.ok(peaks.length >= 6 && peaks.length <= 10, `blinks ${peaks.length}`);
  const peak = weights.findIndex((weight) => weight >= 0.99);
  assert.ok(peak > 3);
  assert.ok((weights[peak - 3] ?? 0) < 0.05);
  assert.ok(weights[peak - 1] > 0.7);
  assert.ok(weights[peak + 1] >= 0.99);
  const opened = weights.findIndex((weight, index) => index > peak && weight < 0.2);
  assert.ok(opened - peak >= 5 && opened - peak <= 8, `open span ${opened - peak}`);
  assert.ok(peaks.some((frame, index) => index > 0 && frame - peaks[index - 1] >= 6 && frame - peaks[index - 1] <= 10));
  const again = compileEpisode(episode);
  assert.deepEqual(again(peak).actors[0].expressions, evaluateEpisodeAtFrame(episode, peak).actors[0].expressions);
  const alt = [];
  for (let frame = 0; frame < 600; frame += 1) alt.push(evaluateEpisodeAtFrame(other, frame).actors[0].expressions.blink ?? 0);
  assert.notDeepEqual(alt, weights);
  const shut = restEpisode((value) => {
    value.shots[0].performances[0].expressions = [{frame: 0, values: {happy: 0.8}}, {frame: 180, values: {happy: 0.8}}];
    value.shots[0].performances[0].reactivity = {look: 'off', head: 0, torso: 0, arm: 0, expression: 0, autoBeats: false, eyes};
  });
  for (let frame = 0; frame < 180; frame += 1) {
    assert.equal(evaluateEpisodeAtFrame(shut, frame).actors[0].expressions.blink ?? 0, 0);
  }
});

test('saccades offset the eyes and leave the head pose on the look', () => {
  const base = {look: 'camera', head: 0.8, torso: 0.3, arm: 0, expression: 0, autoBeats: false};
  const still = restEpisode((value) => {
    value.shots[0].performances[0].reactivity = {...base, eyes: {blinkRate: 16, saccade: 0, seed: 1}};
  });
  const moving = restEpisode((value) => {
    value.shots[0].performances[0].reactivity = {...base, eyes: {blinkRate: 16, saccade: 1, seed: 1}};
  });
  let moved = false;
  for (const frame of [20, 40, 70, 110]) {
    const left = evaluateEpisodeAtFrame(still, frame).actors[0];
    const right = evaluateEpisodeAtFrame(moving, frame).actors[0];
    assert.deepEqual(left.pose.head, right.pose.head);
    assert.deepEqual(left.pose.neck, right.pose.neck);
    if (Math.abs(right.motion.eyeYaw - right.motion.lookYaw) > 0.02) moved = true;
    assert.equal(left.motion.eyeYaw, left.motion.lookYaw);
  }
  assert.equal(moved, true);
  const away = restEpisode((value) => {
    value.shots[0].performances[0].reactivity = {
      ...base, eyes: {saccade: 0, seed: 1, gazeAway: [{frame: 20, duration: 40, yaw: 0.25, pitch: -0.1}]},
    };
  });
  const gazed = evaluateEpisodeAtFrame(away, 30).actors[0];
  const home = evaluateEpisodeAtFrame(away, 10).actors[0];
  assert.ok(gazed.motion.eyeYaw - gazed.motion.lookYaw > 0.15);
  assert.deepEqual(gazed.pose.head, home.pose.head);
  const turning = restEpisode((value) => {
    value.shots[0].performances[0].reactivity = {
      ...base, eyes: {saccade: 0, seed: 1, gazeAway: [{frame: 4, duration: 48, yaw: 0.3, pitch: 0}]},
    };
  });
  let peak = 0;
  let arrived = 0;
  for (let frame = 4; frame < 40; frame += 1) {
    const prev = evaluateEpisodeAtFrame(turning, frame - 1).actors[0];
    const curr = evaluateEpisodeAtFrame(turning, frame).actors[0];
    const step = Math.abs(curr.motion.eyeYaw - prev.motion.eyeYaw) * 180 / Math.PI;
    peak = Math.max(peak, step);
    arrived = Math.max(arrived, curr.motion.eyeYaw - curr.motion.lookYaw);
    assert.deepEqual(curr.pose.head, prev.pose.head);
  }
  assert.ok(peak < 2.4, `gaze step ${peak}`);
  assert.ok(peak > 0.5, `gaze never turned ${peak}`);
  assert.ok(arrived > 0.27, `gaze arrived ${arrived}`);
  const frames = [8, 16, 28, 36];
  const ordered = frames.map((frame) => evaluateEpisodeAtFrame(turning, frame));
  assert.deepEqual(evaluateEpisodeAtFrame(turning, 28), ordered[2]);
  assert.deepEqual(evaluateEpisodeAtFrame(turning, 8), ordered[0]);
});

test('section mood does not pulse happy on each nod', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/music-groove.json', import.meta.url), 'utf8'));
  validateEpisode(fixture);
  const evaluate = compileEpisode(fixture);
  let maxStep = 0;
  for (let frame = 40; frame < 90; frame += 1) {
    const previous = evaluate(frame - 1).actors[0].expressions.happy ?? 0;
    const current = evaluate(frame).actors[0].expressions.happy ?? 0;
    maxStep = Math.max(maxStep, Math.abs(current - previous));
  }
  assert.ok(maxStep < 0.01, `groove happy step ${maxStep}`);
  const intoHook = Math.abs((evaluate(110).actors[0].expressions.happy ?? 0) - (evaluate(90).actors[0].expressions.happy ?? 0));
  assert.ok(intoHook > 0.1);
  assert.ok(Math.abs((evaluate(100).actors[0].expressions.happy ?? 0) - (evaluate(99).actors[0].expressions.happy ?? 0)) < 0.05);
  const drop = restEpisode((episode) => {
    episode.music = {
      bpm: 120,
      beats: [{frame: 0, strength: 1, downbeat: true}, {frame: 60, strength: 1, downbeat: true}],
      sections: [{frame: 0, label: 'groove', energy: 0.5}, {frame: 60, label: 'drop', energy: 1}],
    };
    episode.shots[0].performances[0].reactivity = {
      look: 'off', head: 0, torso: 0, arm: 0, expression: 1, autoBeats: false,
      face: {mood: 'sections', idleMouth: 0, breathMouth: false},
    };
  });
  assert.ok((evaluateEpisodeAtFrame(drop, 62).actors[0].expressions.surprised ?? 0) > 0.2);
  assert.ok((evaluateEpisodeAtFrame(drop, 74).actors[0].expressions.surprised ?? 0) < 0.05);
  const pulsed = baselineEpisode();
  const happyAt = (frame) => evaluateEpisodeAtFrame(pulsed, frame).actors[0].expressions.happy ?? 0;
  assert.ok(happyAt(16) > happyAt(0) + 0.2);
});

test('half-time groove nods land on the beat, lead with the neck, and alternate roll', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/music-groove.json', import.meta.url), 'utf8'));
  const evaluate = compileEpisode(fixture);
  for (const beat of [24, 47, 71, 95, 118]) {
    const head = argmax(fixture, beat - 8, beat + 4, (actor) => actor.motion.grooveHead);
    const neck = argmax(fixture, beat - 10, beat + 4, (actor) => actor.motion.grooveNeck);
    assert.ok(Math.abs(head - beat) <= 1, `head ${head} beat ${beat}`);
    assert.ok(head - neck >= 1 && head - neck <= 2, `lead ${head - neck}`);
  }
  assert.ok(evaluate(95).actors[0].motion.grooveHead > evaluate(71).actors[0].motion.grooveHead);
  const rolled = structuredClone(fixture);
  rolled.shots[0].camera = {position: [0, 1.5, 3], target: [0, 1.5, 0], fov: 32};
  rolled.shots[0].performances[0].reactivity = {
    look: 'off', head: 0, torso: 0, arm: 0, expression: 0, autoBeats: false,
    groove: {division: 'half', amount: 1, phaseFrames: -1, roll: 1, seed: 1},
  };
  const early = rollOf(evaluateEpisodeAtFrame(rolled, 8).actors[0].pose.head.rotation);
  const late = rollOf(evaluateEpisodeAtFrame(rolled, 60).actors[0].pose.head.rotation);
  assert.ok(early * late < 0, `roll ${early} ${late}`);
  assert.ok(Math.abs(early) > 0.01 && Math.abs(late) > 0.01);
  const rolledEval = compileEpisode(rolled);
  for (const beat of [47, 95, 142]) {
    const before = rolledEval(beat - 1).actors[0].pose;
    const at = rolledEval(beat).actors[0].pose;
    const chestStep = Math.abs(rollOf(at.chest.rotation) - rollOf(before.chest.rotation)) * 180 / Math.PI;
    const spineStep = Math.abs(rollOf(at.spine.rotation) - rollOf(before.spine.rotation)) * 180 / Math.PI;
    assert.ok(chestStep < 1.5, `chest step ${chestStep} at ${beat}`);
    assert.ok(spineStep < 0.8, `spine step ${spineStep} at ${beat}`);
    assert.ok(Math.abs(rollOf(at.chest.rotation)) < 1e-6, `downbeat chest ${rollOf(at.chest.rotation)}`);
  }
  const sequential = Array.from({length: 30}, (_, frame) => evaluate(frame));
  for (const frame of [29, 4, 18, 0, 11]) assert.deepEqual(evaluate(frame), sequential[frame]);
});

test('without a music block, groove reshapes nod beats instead of adding a second sine', () => {
  const symmetric = restEpisode((episode) => {
    episode.shots[0].performances[0].reactivity = {
      look: 'off', head: 1, torso: 0.4, arm: 0, expression: 0, autoBeats: false,
      beats: [{frame: 30, kind: 'nod', strength: 1, duration: 16}],
    };
  });
  const shaped = structuredClone(symmetric);
  shaped.shots[0].performances[0].reactivity.groove = {division: 'beat', amount: 1, phaseFrames: -1, roll: 0, seed: 1};
  const oldPeak = argmax(symmetric, 20, 50, (actor) => actor.motion.nod);
  const newPeak = argmax(shaped, 20, 50, (actor) => actor.motion.nod);
  assert.equal(oldPeak, 38);
  assert.ok(Math.abs(newPeak - 30) <= 1, `reshaped peak ${newPeak}`);
  assert.ok(Math.abs(newPeak - oldPeak) >= 6);
  const neck = argmax(shaped, 20, 50, (actor) => actor.motion.grooveNeck ?? pitchOf(actor.pose.neck.rotation));
  assert.ok(newPeak - neck >= 1 && newPeak - neck <= 2);
});

test('idle mouth stays open a crack, and breath plus bar sway stay on the torso', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/music-groove.json', import.meta.url), 'utf8'));
  const evaluate = compileEpisode(fixture);
  for (let frame = 0; frame < 180; frame += 1) {
    const expressions = evaluate(frame).actors[0].expressions;
    const mouth = (expressions.oh ?? 0) + (expressions.aa ?? 0);
    assert.ok(mouth >= 0.02 && mouth <= 0.2, `mouth ${mouth} at ${frame}`);
  }
  const body = restEpisode((episode) => {
    episode.music = fixture.music;
    episode.shots[0].performances[0].reactivity = {
      look: 'camera', head: 0.7, torso: 0.4, arm: 0, expression: 0, autoBeats: false,
      body: {breath: 1, sway: 1, swayDivision: 'bar', seed: 0},
    };
  });
  const sample = compileEpisode(body);
  close(sample(0).actors[0].motion.breath, 0, 1e-9);
  close(sample(30).actors[0].motion.breath, 1, 1e-9);
  close(sample(90).actors[0].motion.breath, -1, 1e-9);
  close(sample(120).actors[0].motion.breath, 0, 1e-9);
  for (const frame of [0, 47, 95, 142]) assert.ok(Math.abs(sample(frame).actors[0].motion.sway) < 1e-9, `sway ${frame}`);
  assert.ok(sample(12).actors[0].motion.sway > 0.99);
  const pose = sample(12).actors[0].pose;
  const chest = rollOf(pose.chest.rotation);
  const world = rollOf(combineRotations(pose, ['spine', 'chest', 'upperChest', 'neck', 'head']));
  assert.ok(Math.abs(chest) > 0.04);
  assert.ok(Math.abs(world) < Math.abs(chest) * 0.5, `world ${world} chest ${chest}`);
  assert.ok(Math.abs(pitchOf(sample(30).actors[0].pose.chest.rotation)) > 0.015);
  const drift = restEpisode((episode) => {
    episode.shots[0].performances[0].reactivity = {
      look: 'off', head: 0, torso: 0, arm: 0, expression: 0, autoBeats: false,
      body: {breath: 0, sway: 1, seed: 0},
    };
  });
  close(evaluateEpisodeAtFrame(drift, 0).actors[0].motion.sway, 0, 1e-9);
  close(evaluateEpisodeAtFrame(drift, 75).actors[0].motion.sway, 1, 1e-9);
});

test('speaking suppresses the idle mouth, and half-time keeps downbeats when the grid is offset', () => {
  const dialogue = compileDialogue({text: 'Hello there.', actorId: 'a', fps: 30, wordsPerMinute: 120, mouthStrength: 0.8});
  const episode = restEpisode((value) => {
    value.dialogue = dialogue;
    value.shots[0].performances[0].reactivity = {
      look: 'off', head: 0, torso: 0, arm: 0, expression: 1, autoBeats: false,
      face: {idleMouth: 0.08, breathMouth: false, mood: 'off'},
    };
  });
  const bare = structuredClone(episode);
  delete bare.shots[0].performances[0].reactivity.face;
  const cue = dialogue.mouthCues[0];
  const during = evaluateEpisodeAtFrame(episode, cue.startFrame + 1).actors[0].expressions;
  const spoken = evaluateEpisodeAtFrame(bare, cue.startFrame + 1).actors[0].expressions;
  assert.equal(during.oh ?? 0, spoken.oh ?? 0);
  assert.equal(during.aa ?? 0, spoken.aa ?? 0);
  const after = dialogue.durationFrames + 10;
  assert.ok((evaluateEpisodeAtFrame(episode, after).actors[0].expressions.oh ?? 0) >= 0.02);
  const selected = selectGrooveBeats([
    {frame: 0, strength: 1, downbeat: false},
    {frame: 10, strength: 1, downbeat: true},
    {frame: 20, strength: 1, downbeat: false},
    {frame: 30, strength: 1, downbeat: false},
    {frame: 40, strength: 1, downbeat: false},
    {frame: 50, strength: 1, downbeat: true},
  ], 'half');
  assert.deepEqual(selected.map((beat) => beat.frame), [10, 30, 50]);
});

test('music and life blocks reject malformed timelines', () => {
  const badMusic = restEpisode((episode) => {
    episode.music = {bpm: 152, beats: [{frame: 20, strength: 1}, {frame: 10, strength: 1}]};
  });
  assert.throws(() => validateEpisode(badMusic), /increasing/);
  const badLabel = restEpisode((episode) => {
    episode.music = {bpm: 100, beats: [{frame: 0, strength: 1}], sections: [{frame: 0, label: 'chorus', energy: 1}]};
  });
  assert.throws(() => validateEpisode(badLabel), /section/);
  const badEyes = restEpisode((episode) => {
    episode.shots[0].performances[0].reactivity.eyes = {blinkRate: 3};
  });
  assert.throws(() => validateEpisode(badEyes), /blinkRate/);
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/music-groove.json', import.meta.url), 'utf8'));
  assert.equal(fixture.music.beats.length, 16);
  assert.doesNotThrow(() => validateEpisode(fixture));
});

test('import-beats merges a beats file onto an episode and refuses to invent audio decoding', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'beats-'));
  const episode = restEpisode();
  const episodePath = path.join(dir, 'episode.json');
  const beatsPath = path.join(dir, 'beats.json');
  const outPath = path.join(dir, 'out.json');
  writeFileSync(episodePath, JSON.stringify(episode));
  writeFileSync(beatsPath, JSON.stringify({
    bpm: 100, offsetSeconds: 1.5,
    beats: [{frame: 0, strength: 0.8, downbeat: true}, {frame: 18, strength: 0.4}],
    sections: [{frame: 0, label: 'groove', energy: 0.5}],
  }));
  const merged = spawnSync(process.execPath, [
    path.join(root, 'scripts/import-beats.mjs'), beatsPath, '--episode', episodePath, '--out', outPath,
  ], {encoding: 'utf8'});
  assert.equal(merged.status, 0, merged.stderr);
  const written = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(written.music.bpm, 100);
  assert.equal(written.music.beats[1].downbeat, undefined);
  assert.deepEqual(written.music.intensityCues, [{frame: 0, intensity: 0.8, duration: 6}]);
  assert.equal(written.shots[0].performances[0].reactivity.groove, undefined);
  const audio = spawnSync(process.execPath, [
    path.join(root, 'scripts/import-beats.mjs'), path.join(dir, 'missing.wav'),
    '--start', '0', '--duration', '2', '--fps', '30', '--out', path.join(dir, 'audio.json'),
  ], {encoding: 'utf8'});
  assert.notEqual(audio.status, 0);
  assert.match(`${audio.stderr}`, /librosa|python|audio/i);
});

test('a point does not paint surprised when the arm is unused or a music face owns the expression', () => {
  const beats = [{frame: 8, kind: 'point', strength: 1, duration: 16}];
  const at = (reactivity, extra) => evaluateEpisodeAtFrame(restEpisode((episode) => {
    episode.music = {
      bpm: 120,
      beats: [{frame: 0, strength: 0.5, downbeat: true}],
      sections: [{frame: 0, label: 'groove', energy: 0.62}],
    };
    extra?.(episode);
    episode.shots[0].performances[0].reactivity = reactivity;
  }, 40), 16).actors[0];
  const idleArm = at({look: 'off', head: 0, torso: 0.4, arm: 0, expression: 1, autoBeats: false, beats});
  assert.equal(idleArm.expressions.surprised ?? 0, 0);
  assert.equal(idleArm.motion.aim, undefined);
  const armed = at({look: 'off', head: 0, torso: 0.4, arm: 0.6, expression: 1, autoBeats: false, beats});
  assert.ok((armed.expressions.surprised ?? 0) > 0.2, armed.expressions.surprised);
  assert.ok(armed.motion.aim.weight > 0);
  const music = at({
    look: 'off', head: 0, torso: 0, arm: 0.6, expression: 0.8, autoBeats: false, beats,
    face: {mood: 'sections', idleMouth: 0, breathMouth: false},
  });
  assert.equal(music.expressions.surprised ?? 0, 0);
  assert.ok((music.expressions.relaxed ?? 0) > 0.05, music.expressions.relaxed);
  const opted = at({
    look: 'off', head: 0, torso: 0, arm: 0.6, expression: 0.8, autoBeats: false, beats,
    face: {mood: 'sections', idleMouth: 0, breathMouth: false, gestures: true},
  });
  assert.ok((opted.expressions.surprised ?? 0) > 0.2, opted.expressions.surprised);
  assert.ok((opted.expressions.relaxed ?? 0) > 0.05);
  const scaledOff = at({
    look: 'off', head: 0, torso: 0, arm: 0.6, expression: 1, autoBeats: false, beats, gestureFace: 0,
  });
  assert.equal(scaledOff.expressions.surprised ?? 0, 0);
  const punched = at({
    look: 'off', head: 0, torso: 0, arm: 0, expression: 1, autoBeats: false,
    face: {mood: 'off', idleMouth: 0, breathMouth: false},
  }, (episode) => {
    episode.shots[0].camera.motion = [
      {frame: 0, position: [0, 1.5, 2.4], target: [0, 1.5, 0], fov: 28, easing: 'step'},
      {frame: 16, position: [0, 1.5, 1.5], target: [0, 1.5, 0], fov: 18},
      {frame: 40, position: [0, 1.5, 1.5], target: [0, 1.5, 0], fov: 18},
    ];
  });
  assert.equal(punched.expressions.surprised ?? 0, 0);
  const speechPunch = at({
    look: 'off', head: 0, torso: 0, arm: 0, expression: 1, autoBeats: false,
  }, (episode) => {
    episode.shots[0].camera.motion = [
      {frame: 0, position: [0, 1.5, 2.4], target: [0, 1.5, 0], fov: 28, easing: 'step'},
      {frame: 16, position: [0, 1.5, 1.5], target: [0, 1.5, 0], fov: 18},
      {frame: 40, position: [0, 1.5, 1.5], target: [0, 1.5, 0], fov: 18},
    ];
  });
  assert.ok((speechPunch.expressions.surprised ?? 0) > 0.2, speechPunch.expressions.surprised);
  assert.throws(() => validateEpisode(restEpisode((episode) => {
    episode.shots[0].performances[0].reactivity.face = {gestures: 'no'};
  })), /gestures/);
  assert.throws(() => validateEpisode(restEpisode((episode) => {
    episode.shots[0].performances[0].reactivity.gestureFace = 2;
  })), /gestureFace/);
});

test('groove roll stays under the off-downbeat step on every downbeat', () => {
  const fps = 30;
  const beats = [];
  for (let index = 0; index < 64; index += 1) {
    beats.push({frame: Math.round(index * 15.65), strength: 0.8, downbeat: index % 4 === 0});
  }
  const degrees = 180 / Math.PI;
  const steps = [];
  let low = Infinity;
  let high = -Infinity;
  let swayLow = Infinity;
  let swayHigh = -Infinity;
  for (let frame = 1; frame < 900; frame += 1) {
    const groove = sampleGroove({frame, fps, groove: {}, musicBeats: beats, lookActive: true});
    const body = sampleBody({frame, fps, body: {}, musicBeats: beats, lookActive: true});
    const before = sampleGroove({frame: frame - 1, fps, groove: {}, musicBeats: beats, lookActive: true});
    const beforeBody = sampleBody({frame: frame - 1, fps, body: {}, musicBeats: beats, lookActive: true});
    const chest = ((groove.roll + body.chestRoll) - (before.roll + beforeBody.chestRoll)) * degrees;
    const spine = ((groove.roll * 0.35 + body.spineRoll) - (before.roll * 0.35 + beforeBody.spineRoll)) * degrees;
    low = Math.min(low, groove.roll * degrees);
    high = Math.max(high, groove.roll * degrees);
    swayLow = Math.min(swayLow, body.chestRoll * degrees);
    swayHigh = Math.max(swayHigh, body.chestRoll * degrees);
    const downbeat = beats.some((beat) => beat.downbeat && Math.abs(beat.frame - frame) <= 1);
    steps.push({frame, chest, spine, downbeat});
  }
  const down = steps.filter((step) => step.downbeat);
  const off = steps.filter((step) => !step.downbeat);
  const maxAbs = (rows, key) => Math.max(...rows.map((row) => Math.abs(row[key])));
  const downChest = maxAbs(down, 'chest');
  const offChest = maxAbs(off, 'chest');
  assert.ok(downChest <= 0.53, `downbeat chest ${downChest}`);
  assert.ok(downChest <= offChest, `down ${downChest} off ${offChest}`);
  assert.ok(maxAbs(down, 'spine') <= downChest, `spine ${maxAbs(down, 'spine')}`);
  assert.ok(high - low >= 5.9, `roll peak-to-peak ${high - low}`);
  assert.ok(swayHigh - swayLow >= 5.7, `sway peak-to-peak ${swayHigh - swayLow}`);
  let worstRatio = 0;
  for (const beat of beats.filter((item) => item.downbeat && item.frame > 8 && item.frame < 890)) {
    const here = Math.abs(steps.find((step) => step.frame === beat.frame).chest);
    const neighbor = steps
      .filter((step) => Math.abs(step.frame - beat.frame) <= 8 && step.frame !== beat.frame)
      .map((step) => Math.abs(step.chest))
      .sort((left, right) => left - right);
    const median = neighbor[Math.floor(neighbor.length / 2)];
    worstRatio = Math.max(worstRatio, here / Math.max(median, 1e-6));
  }
  assert.ok(worstRatio <= 1.5, `downbeat vs local median ${worstRatio}`);
});

test('the multi-frame look-away is the eyes, and the head is already on the new camera', () => {
  const beats = [];
  for (let index = 0; index < 6; index += 1) beats.push({frame: index * 15, strength: 0.8, downbeat: index % 4 === 0});
  const life = {
    look: 'camera', head: 0.78, torso: 0.42, arm: 0, expression: 0, autoBeats: false,
    groove: {division: 'half', amount: 1, roll: 0.65},
    eyes: {saccade: 0, seed: 1, gazeAway: [{frame: 6, duration: 36, yaw: 0.3, pitch: 0}]},
  };
  const shot = (id, startFrame, position, reactivity) => ({
    id, startFrame, durationFrames: 40,
    camera: {position, target: [0, 1.45, 0], fov: 22},
    performances: [{
      actorId: 'a',
      sequence: {duration: 40 / 30, keyframes: [{time: 0, pose: {}}, {time: 40 / 30, pose: {}}]},
      reactivity,
    }],
  });
  const episode = {
    schema: EPISODE_SCHEMA, fps: 30, durationFrames: 80,
    actors: [{id: 'a', assetId: 'synthetic'}],
    music: {bpm: 120, beats},
    shots: [
      shot('wide', 0, [0.2, 1.5, 1.8], {...life, eyes: {saccade: 0, seed: 1}}),
      shot('ecu', 40, [-0.8, 1.3, 1.1], life),
    ],
  };
  const degrees = 180 / Math.PI;
  const angle = (left, right) => {
    const dot = Math.abs(left[0] * right[0] + left[1] * right[1] + left[2] * right[2] + left[3] * right[3]);
    return 2 * Math.acos(Math.min(1, dot)) * degrees;
  };
  const sample = compileEpisode(episode);
  const cut = sample(40).actors[0];
  const beforeCut = sample(39).actors[0];
  const lookStep = Math.hypot(cut.motion.lookYaw - beforeCut.motion.lookYaw, cut.motion.lookPitch - beforeCut.motion.lookPitch) * degrees;
  assert.ok(lookStep > 20, `cut look ${lookStep}`);
  assert.ok(angle(cut.pose.head.rotation, beforeCut.pose.head.rotation) > 5);
  let headAfter = 0;
  for (let frame = 41; frame <= 48; frame += 1) {
    const step = angle(sample(frame).actors[0].pose.head.rotation, sample(frame - 1).actors[0].pose.head.rotation);
    headAfter = Math.max(headAfter, step);
  }
  assert.ok(headAfter < 1.67, `head after cut ${headAfter}`);
  const lookNext = Math.hypot(
    sample(41).actors[0].motion.lookYaw - cut.motion.lookYaw,
    sample(41).actors[0].motion.lookPitch - cut.motion.lookPitch,
  ) * degrees;
  assert.ok(lookNext < 0.5, `look keeps moving ${lookNext}`);
  const gaze = structuredClone(episode);
  const home = structuredClone(episode);
  delete home.shots[1].performances[0].reactivity.groove;
  delete gaze.shots[1].performances[0].reactivity.groove;
  home.shots[1].performances[0].reactivity.eyes = {saccade: 0, seed: 1};
  const gazed = compileEpisode(gaze);
  const held = compileEpisode(home);
  const eyeSteps = [];
  for (let frame = 46; frame < 70; frame += 1) {
    const curr = gazed(frame).actors[0];
    const prev = gazed(frame - 1).actors[0];
    assert.deepEqual(curr.pose.head, held(frame).actors[0].pose.head);
    eyeSteps.push((curr.motion.eyeYaw - prev.motion.eyeYaw) * degrees);
  }
  const peak = Math.max(...eyeSteps.map(Math.abs));
  assert.ok(peak < 2.4 && peak > 0.4, `eye peak ${peak}`);
  let second = 0;
  for (let index = 1; index < eyeSteps.length; index += 1) {
    second = Math.max(second, Math.abs(eyeSteps[index] - eyeSteps[index - 1]));
  }
  assert.ok(second < 0.6, `eye velocity step ${second}`);
  const forward = Array.from({length: 80}, (_, frame) => sample(frame));
  for (const frame of [70, 40, 5, 46, 0, 79]) assert.deepEqual(sample(frame), forward[frame]);
});
