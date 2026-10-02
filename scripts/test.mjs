#!/usr/bin/env node
// Direct imports also work on hosts whose node --test worker spawning is restricted.
await import('../tests/episode.test.mjs');
await import('../tests/camera-language.test.mjs');
await import('../tests/assets.test.mjs');
await import('../tests/jobs.test.mjs');
await import('../tests/vrm-pose.test.mjs');
await import('../tests/draw-order.test.mjs');
await import('../tests/compiled.test.mjs');
await import('../tests/poselab.test.mjs');
await import('../tests/dialogue.test.mjs');
await import('../tests/dialogue-episode.test.mjs');
await import('../tests/script-project.test.mjs');
await import('../tests/subtitles.test.mjs');
