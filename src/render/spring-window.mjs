/**
 * Seek-safe spring replay. Each frame resets the solver and integrates only
 * the previous `windowFrames` poses, so the result depends on (episode, frame)
 * and not on which frame rendered last. The window is an approximation of
 * the solver's infinite history: tails older than the window are rest.
 */

export function replaySprings(managers, frame, windowFrames, delta, applyFrame) {
  const start = Math.max(0, frame - windowFrames + 1);
  // reset() samples the current parent matrices. Callers restore the bind pose first.
  for (const manager of managers) manager.reset();
  for (let cursor = start; cursor <= frame; cursor += 1) {
    applyFrame(cursor);
    for (const manager of managers) manager.update(delta);
  }
}
