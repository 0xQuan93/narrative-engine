#!/usr/bin/env node
import {readFile, stat} from 'node:fs/promises';
import {writeSubtitleSidecars} from '../src/subtitles.mjs';

const usage = 'Usage: npm run subtitles -- <episode.json> <output-prefix> [--force]';
const args = process.argv.slice(2);
const force = args.includes('--force');
const positional = args.filter((arg) => arg !== '--force');
if (positional.length !== 2 || args.length !== positional.length + Number(force)) {
  console.error(usage);
  process.exitCode = 1;
} else {
  try {
    const [source, prefix] = positional;
    const info = await stat(source);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('Episode must be a file of at most 64 MiB');
    const episode = JSON.parse(await readFile(source, 'utf8'));
    const result = await writeSubtitleSidecars(episode, prefix, {force});
    console.log(`Exported ${result.captionCount} captions: ${result.srt} and ${result.vtt}`);
  } catch (error) {
    console.error(`Subtitle export failed: ${error.message}`);
    process.exitCode = 1;
  }
}
