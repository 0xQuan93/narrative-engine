import test from 'node:test';
import assert from 'node:assert/strict';
import {poseForVrm} from '../src/vrm-pose.mjs';

test('VRM0 canonical axes convert involutively without changing input', () => {
  const pose = {hips: {rotation: [0.1, 0.2, 0.3, 0.9], position: [1, 2, 3]}};
  const converted = poseForVrm(pose, '0');
  assert.deepEqual(converted.hips, {rotation: [-0.1, 0.2, -0.3, 0.9], position: [-1, 2, -3]});
  assert.deepEqual(poseForVrm(converted, '0'), pose);
  assert.deepEqual(poseForVrm(pose, '1'), pose);
  converted.hips.position[0] = 123;
  assert.equal(pose.hips.position[0], 1);
});
test('unsupported non-hips translations fail rather than silently disappearing', () => {
  assert.throws(() => poseForVrm({head: {position: [0, 0.1, 0]}}, '1'), /hips only/);
  assert.doesNotThrow(() => poseForVrm({head: {position: [0, 0, 0]}}, '1'));
});
