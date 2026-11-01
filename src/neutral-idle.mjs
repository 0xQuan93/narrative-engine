/**
 * PoseLab's Neutral Idle, the calm loop (about 8.1s, body under ~1.5°/frame).
 * Happy Idle is a different clip. Music cuts use this one unless a take asks
 * for the imported idle. The bank JSON is sampled with the same importer as
 * any other PoseLab clip. `sourceVrm` matches `npm run setup -- --source-vrm`.
 */
import clip from '../assets/poselab/idle-neutral-animation.json' with { type: 'json' };
import { samplePoseLabClip } from './poselab.mjs';

const cache = new Map();

export function neutralIdleSequence(sourceVrm = '0') {
  if (!cache.has(sourceVrm)) {
    cache.set(sourceVrm, samplePoseLabClip(clip, {fps: 30, sourceVrm}).sequence);
  }
  return cache.get(sourceVrm);
}
