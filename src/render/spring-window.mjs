/**
 * Seek-safe spring replay. Each frame resets the solver and integrates only
 * the previous `windowFrames` poses, so the result depends on (episode, frame)
 * and not on which frame rendered last.
 *
 * Resetting onto the first pose of a short window kicks low-drag strands
 * sideways; that ring is still visible 24 frames later. `settleFrames` holds
 * the window-start pose and integrates until that kick dies, then the real
 * window runs. Settle is a pure function of the options, not of the last render.
 */

/** Hold the window-start pose this many steps before the visible window. */
export const SPRING_SETTLE_FRAMES = 24;

export function replaySprings(managers, frame, windowFrames, delta, applyFrame, {settleFrames = SPRING_SETTLE_FRAMES} = {}) {
  const start = Math.max(0, frame - windowFrames + 1);
  const settle = Math.max(0, settleFrames);
  // reset() samples the current parent matrices. Callers restore the bind pose first.
  for (const manager of managers) manager.reset();
  if (settle > 0) {
    applyFrame(start);
    for (let step = 0; step < settle; step += 1) {
      for (const manager of managers) manager.update(delta);
    }
  }
  for (let cursor = start; cursor <= frame; cursor += 1) {
    applyFrame(cursor);
    for (const manager of managers) manager.update(delta);
  }
}
