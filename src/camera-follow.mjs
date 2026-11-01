/**
 * Opt-in camera follow for tight music close-ups.
 *
 * The evaluator has no skinned skeleton, so the head position is a short
 * forward-kinematic estimate from the normalized pose (hips through head).
 * At rest it matches `actorHeadPosition`. Follow is applied after look, so
 * the eyes still aim at the authored lens while the lens lags the head.
 */

import {ACTOR_SPACING, HEAD_ANCHOR} from './reactive-motion.mjs';

const REST = [0, 0, 0, 1];
const CHAIN = [
  ['spine', 0.15],
  ['chest', 0.12],
  ['upperChest', 0.10],
  ['neck', 0.08],
  ['head', 0.10],
];
const HIPS_Y = HEAD_ANCHOR[1] - CHAIN.reduce((sum, [, length]) => sum + length, 0);
const MAX_SHIFT = 0.45;

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

function rotateVec(q, v) {
  const turned = mul(mul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);
  return [turned[0], turned[1], turned[2]];
}

/** World-space head estimate. `pose` null is the rest anchor. */
export function estimateHeadPosition(pose, actorIndex, actorCount) {
  const slot = (actorIndex - (actorCount - 1) / 2) * ACTOR_SPACING;
  const hips = pose?.hips?.position ?? [0, 0, 0];
  let rotation = pose?.hips?.rotation ?? REST;
  let position = [slot + hips[0], HIPS_Y + hips[1], HEAD_ANCHOR[2] + hips[2]];
  for (const [bone, length] of CHAIN) {
    const local = pose?.[bone]?.rotation;
    if (local) rotation = mul(rotation, local);
    const step = rotateVec(rotation, [0, length, 0]);
    position = [position[0] + step[0], position[1] + step[1], position[2] + step[2]];
  }
  return position;
}

function clampShift(shift) {
  const length = Math.hypot(shift[0], shift[1], shift[2]);
  if (length <= MAX_SHIFT || length < 1e-8) return shift;
  const scale = MAX_SHIFT / length;
  return shift.map((value) => value * scale);
}

/**
 * Translate the authored camera by the lagged head delta, then optionally
 * pull back along the view ray so an extreme close-up keeps cheek room.
 */
export function applyCameraFollow(camera, {head, restHead, amount = 1, margin = 0}) {
  const shift = clampShift([
    (head[0] - restHead[0]) * amount,
    (head[1] - restHead[1]) * amount,
    (head[2] - restHead[2]) * amount,
  ]);
  const position = camera.position.map((value, index) => value + shift[index]);
  const target = camera.target.map((value, index) => value + shift[index]);
  if (margin > 0) {
    const view = position.map((value, index) => value - target[index]);
    const length = Math.hypot(...view) || 1;
    for (let index = 0; index < 3; index += 1) position[index] += (view[index] / length) * margin;
  }
  const next = {...camera, position, target};
  if (margin > 0 && camera.depthOfField) {
    next.depthOfField = {
      ...camera.depthOfField,
      focusDistance: camera.depthOfField.focusDistance + margin,
    };
  }
  return next;
}

/**
 * Orbit the lens around its target. Positive degrees pitch the camera up
 * (the camera drops, the view looks up) so a close-up can see under a fringe.
 * Distance and target stay put. Call this after follow.
 */
export function pitchCamera(camera, degrees) {
  if (!degrees) return camera;
  const rad = degrees * Math.PI / 180;
  const offset = camera.position.map((value, index) => value - camera.target[index]);
  const forwardZ = camera.target[2] - camera.position[2];
  const forwardX = camera.target[0] - camera.position[0];
  const right = [-forwardZ, 0, forwardX];
  const length = Math.hypot(right[0], right[1], right[2]);
  if (length < 1e-8) return camera;
  const axis = right.map((value) => value / length);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const along = axis[0] * offset[0] + axis[1] * offset[1] + axis[2] * offset[2];
  const crossed = [
    axis[1] * offset[2] - axis[2] * offset[1],
    axis[2] * offset[0] - axis[0] * offset[2],
    axis[0] * offset[1] - axis[1] * offset[0],
  ];
  const rotated = offset.map((value, index) => value * cos + crossed[index] * sin + axis[index] * along * (1 - cos));
  return {...camera, position: camera.target.map((value, index) => value + rotated[index])};
}
