#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEpisode } from '../src/episode.mjs';
import { normalizeImportedMusic } from '../src/music.mjs';

const usage = `Usage:
  npm run import:beats -- beats.json --episode episode.json --out episode.json
  npm run import:beats -- song.mp3 --start 144.13 --duration 20 --fps 30 --out beats.json [--bpm 152]

The audio path needs a local python3 with librosa and numpy. It is offline analysis only.
Rendering never decodes audio.`;

const AUDIO = /\.(mp3|wav|flac|ogg|m4a)$/i;

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!['episode', 'out', 'start', 'duration', 'fps', 'bpm', 'audio'].includes(key) || !value || value.startsWith('--')) {
      throw new Error(usage);
    }
    options[key] = value;
    index += 1;
  }
  return { positional, options };
}

function extractAudio(audio, options) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'extract-beats.py');
  const args = [script, audio, '--start', options.start ?? '0', '--duration', options.duration ?? '20', '--fps', options.fps ?? '30'];
  if (options.bpm) args.push('--bpm', options.bpm);
  const result = spawnSync('python3', args, { encoding: 'utf8' });
  if (result.error) throw new Error('import-beats needs python3 with librosa and numpy. The renderer does not use them.');
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Beat import failed').trim());
  return JSON.parse(result.stdout);
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (!options.out) throw new Error(usage);
  const audio = options.audio ?? (AUDIO.test(positional[0] ?? '') ? positional[0] : null);
  const jsonPath = audio ? null : positional[0];
  if (!audio && !jsonPath) throw new Error(usage);
  const doc = audio ? extractAudio(audio, options) : JSON.parse(await readFile(jsonPath, 'utf8'));
  if (!options.episode) {
    const duration = Math.max(...(doc.beats ?? doc.music?.beats ?? [{ frame: 1 }]).map((beat) => beat.frame)) + 1;
    const music = normalizeImportedMusic(doc, duration);
    await writeFile(options.out, `${JSON.stringify(music, null, 2)}\n`);
    console.log(`Wrote ${music.beats.length} beats to ${options.out}`);
    return;
  }
  const episode = JSON.parse(await readFile(options.episode, 'utf8'));
  episode.music = normalizeImportedMusic(doc, episode.durationFrames);
  validateEpisode(episode);
  await writeFile(options.out, `${JSON.stringify(episode, null, 2)}\n`);
  console.log(`Wrote music (${episode.music.beats.length} beats) onto ${options.out}`);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
