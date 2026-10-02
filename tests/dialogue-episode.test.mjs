import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileDialogue, MOUTH_SHAPES} from '../src/dialogue.mjs';
import {compileEpisode, evaluateEpisodeAtFrame, validateEpisode} from '../src/episode.mjs';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/technical-shot.json', import.meta.url)));

test('dialogue adds deterministic mouth weights while preserving body poses and other expressions', () => {
  const original = fixture();
  const episode = structuredClone(original);
  episode.dialogue = compileDialogue({text: 'A E I O U.', actorId: 'performer', wordsPerMinute: 240});
  const evaluate = compileEpisode(episode);
  const frames = episode.dialogue.mouthCues.map((cue) => Math.floor((cue.startFrame + cue.endFrame) / 2));
  const ordered = new Map(frames.map((frame) => [frame, evaluate(frame)]));
  for (const frame of [...frames].reverse()) {
    const result = evaluate(frame), before = evaluateEpisodeAtFrame(original, frame);
    assert.deepEqual(result, ordered.get(frame));
    assert.deepEqual(result.actors[0].pose, before.actors[0].pose);
    assert.deepEqual(result.camera, before.camera);
    assert.equal(result.actors[0].expressions.happy, before.actors[0].expressions.happy);
    assert.ok(MOUTH_SHAPES.some((shape) => result.actors[0].expressions[shape] > 0));
  }
  const after = evaluate(episode.dialogue.durationFrames);
  for (const shape of MOUTH_SHAPES) assert.equal(after.actors[0].expressions[shape], 0);
});

test('dialogue belonging to another actor cannot change a non-speaker mouth', () => {
  const episode = fixture();
  episode.actors.push({id: 'listener', assetId: 'listener-vrm'});
  episode.dialogue = compileDialogue({text: 'Hello.', actorId: 'performer'});
  const result = evaluateEpisodeAtFrame(episode, 5);
  assert.deepEqual(result.actors[1].expressions, {});
});

test('invalid dialogue fps, length, speaker or hidden speaking actor fails before rendering', () => {
  const original = fixture();
  original.dialogue = compileDialogue({text: 'Hello.', actorId: 'performer'});
  for (const mutate of [
    (e) => e.dialogue.fps = 24,
    (e) => e.dialogue.actorId = 'missing',
    (e) => e.dialogue.durationFrames = e.durationFrames + 1,
    (e) => e.shots[0].performances = [],
  ]) {
    const episode = structuredClone(original); mutate(episode);
    assert.throws(() => validateEpisode(episode));
  }
});
