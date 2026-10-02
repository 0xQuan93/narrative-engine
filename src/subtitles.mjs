import {link, rename, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateEpisode} from './episode.mjs';

// Dialogue frame intervals are half-open. Round each absolute boundary once so
// adjacent cues retain the same boundary in both formats at non-integer ms fps.
function timestamp(frame, fps, separator) {
  if (frame > Number.MAX_SAFE_INTEGER / 1000) throw new Error('Caption frame is too large for millisecond timestamps');
  const milliseconds = Math.round(frame * 1000 / fps);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1_000) % 60;
  const fraction = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(fraction).padStart(3, '0')}`;
}

// Script captions are plain text, even when a writer types markup characters.
const cueText = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderSubtitleSidecars(episode) {
  validateEpisode(episode);
  if (!episode.dialogue?.captions.length) throw new Error('Episode has no dialogue captions to export');
  const {fps, dialogue: {captions}} = episode;
  const cues = captions.map((caption, index) => {
    const start = timestamp(caption.startFrame, fps, ',');
    const end = timestamp(caption.endFrame, fps, ',');
    return {number: index + 1, start, end, text: cueText(caption.text)};
  });
  const srt = cues.map(({number, start, end, text}) => `${number}\n${start} --> ${end}\n${text}\n`).join('\n');
  const vtt = `WEBVTT\n\n${cues.map(({start, end, text}) => `${start.replace(',', '.')} --> ${end.replace(',', '.')}\n${text}\n`).join('\n')}`;
  return {srt, vtt};
}

export async function writeSubtitleSidecars(episode, outputPrefix, {force = false} = {}) {
  if (typeof outputPrefix !== 'string' || !outputPrefix.trim()) throw new Error('Output prefix is required');
  if (typeof force !== 'boolean') throw new Error('force must be a boolean');
  const content = renderSubtitleSidecars(episode);
  const prefix = path.resolve(outputPrefix);
  const targets = [['srt', `${prefix}.srt`], ['vtt', `${prefix}.vtt`]];
  const staged = [];
  const created = [];
  try {
    for (const [format, target] of targets) {
      const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
      await writeFile(temp, content[format], {flag: 'wx', encoding: 'utf8'});
      staged.push([temp, target]);
    }
    for (const [temp, target] of staged) {
      if (force) await rename(temp, target);
      else { await link(temp, target); created.push(target); }
    }
  } catch (error) {
    if (!force) await Promise.all(created.map((target) => unlink(target).catch(() => {})));
    throw error;
  } finally {
    await Promise.all(staged.map(([temp]) => unlink(temp).catch(() => {})));
  }
  return {srt: targets[0][1], vtt: targets[1][1], captionCount: episode.dialogue.captions.length};
}
