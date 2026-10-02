#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectVrm, importVrm} from '../src/assets.mjs';
import {samplePoseLabClip, importPoseLabFile} from '../src/poselab.mjs';
import {createScriptEpisode, DEFAULT_SCRIPT_SETTINGS} from '../src/script-project.mjs';
import {validateEpisode} from '../src/episode.mjs';
import {atomicJson} from '../src/jobs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: npm run setup -- --vrm /path/to/avatar.vrm --wave /path/to/wave-animation.json --idle /path/to/idle-animation.json --source-vrm 0|1';

function optionsFrom(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!['vrm', 'wave', 'idle', 'source-vrm'].includes(key) || !args[i]?.startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(options, key)) throw new Error(usage);
    options[key] = key === 'source-vrm' ? args[i + 1] : path.resolve(args[i + 1]);
  }
  if (Object.keys(options).length !== 4 || !['0', '1'].includes(options['source-vrm'])) throw new Error(usage);
  return options;
}

function checkMouthExpressions(summary) {
  const required = summary.extension === 'VRM' ? ['a', 'i', 'u', 'e', 'o'] : ['aa', 'ih', 'ou', 'ee', 'oh'];
  const available = new Set(summary.expressions);
  const missing = required.filter((name) => !available.has(name));
  if (missing.length) throw new Error(`Script Studio needs the standard ${summary.extension} mouth expressions; missing: ${missing.join(', ')}`);
}

function baseEpisode() {
  const cameras = [
    {position: [0.25, 1.05, 3.5], target: [0, 0.92, 0], fov: 38},
    {position: [1.05, 1.45, 2.6], target: [0, 1.24, 0], fov: 30},
    {position: [-0.45, 1.55, 2.1], target: [0, 1.43, 0], fov: 25},
  ];
  const rest = {duration: 4, keyframes: [{time: 0, pose: {}}, {time: 4, pose: {}}]};
  const episode = {schema: 'narrative-episode/0.1', fps: 30, durationFrames: 360,
    actors: [{id: 'performer', assetId: 'avatar'}],
    shots: cameras.map((camera, index) => ({id: `camera-${index + 1}`, startFrame: index * 120,
      durationFrames: 120, camera, performances: [{actorId: 'performer', sequence: rest}]}))};
  validateEpisode(episode);
  return episode;
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  const avatar = inspectVrm(await readFile(options.vrm));
  checkMouthExpressions(avatar);
  for (const name of ['wave', 'idle']) {
    const clip = JSON.parse(await readFile(options[name], 'utf8'));
    samplePoseLabClip(clip, {fps: 30, sourceVrm: options['source-vrm']});
  }
  const setupDir = path.join(root, 'out/setup');
  await importVrm(options.vrm, root, 'avatar');
  const waveResult = await importPoseLabFile(options.wave, path.join(setupDir, 'wave.sequence.json'), {fps: 30, sourceVrm: options['source-vrm']});
  const idleResult = await importPoseLabFile(options.idle, path.join(setupDir, 'idle.sequence.json'), {fps: 30, sourceVrm: options['source-vrm']});
  const [wave, idle] = await Promise.all([waveResult, idleResult].map((result) => readFile(result.output, 'utf8').then(JSON.parse)));
  const base = baseEpisode();
  const firstTake = createScriptEpisode({baseEpisode: base, wave, idle, settings: DEFAULT_SCRIPT_SETTINGS});
  await atomicJson(path.join(setupDir, 'base-episode.json'), base);
  await atomicJson(path.join(setupDir, 'first-take.json'), firstTake);
  console.log('Local setup complete. Run npm run gui, or render out/setup/first-take.json with npm run render.');
}

main().catch((error) => {console.error(`Setup failed: ${error.message}`); process.exitCode = 1;});
