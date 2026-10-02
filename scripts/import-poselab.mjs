#!/usr/bin/env node
import { importPoseLabFile } from '../src/poselab.mjs';

const [source, output, ...args] = process.argv.slice(2);
const options = {};
let valid = Boolean(source && output);
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]; const value = args[index + 1];
  if (key === '--source-vrm' && !Object.hasOwn(options, 'sourceVrm')) options.sourceVrm = value;
  else if (key === '--fps' && !Object.hasOwn(options, 'fps') && /^\d+$/.test(value ?? '')) options.fps = Number(value);
  else valid = false;
}
if (!valid || !['0', '1'].includes(options.sourceVrm)) {
  console.error('Usage: node scripts/import-poselab.mjs <animation.json> <output.sequence.json> --source-vrm 0|1 [--fps 30]');
  process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(await importPoseLabFile(source, output, options), null, 2)); }
  catch (error) { console.error(`Import failed: ${error.message}`); process.exitCode = 1; }
}
