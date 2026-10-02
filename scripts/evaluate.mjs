#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { evaluateEpisodeAtFrame } from '../src/episode.mjs';

const [filename, frameText, ...extra] = process.argv.slice(2);
if (!filename || !/^(0|[1-9]\d*)$/.test(frameText ?? '') || extra.length) {
  console.error('Usage: node scripts/evaluate.mjs <episode.json> <integer-frame>');
  process.exitCode = 1;
} else {
  try {
    const episode = JSON.parse(await readFile(filename, 'utf8'));
    console.log(JSON.stringify(evaluateEpisodeAtFrame(episode, Number(frameText)), null, 2));
  } catch (error) {
    console.error(`Evaluation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
