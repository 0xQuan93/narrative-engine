import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileEpisode, evaluateEpisodeAtFrame} from '../src/episode.mjs';

test('compiled evaluator captures validated input and returns independent frames', () => {
  const episode = JSON.parse(readFileSync(new URL('./fixtures/technical-shot.json', import.meta.url)));
  const expected = evaluateEpisodeAtFrame(episode, 45);
  const evaluate = compileEpisode(episode);
  episode.shots[0].camera.position[0] = 1000;
  assert.deepEqual(evaluate(45), expected);
  const first = evaluate(45); first.actors[0].pose.head.rotation[0] = 123;
  assert.deepEqual(evaluate(45), expected);
  assert.throws(() => evaluate(180), /frame/);
});
