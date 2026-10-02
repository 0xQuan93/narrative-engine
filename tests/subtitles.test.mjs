import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createScriptEpisode, DEFAULT_SCRIPT_SETTINGS} from '../src/script-project.mjs';
import {renderSubtitleSidecars, writeSubtitleSidecars} from '../src/subtitles.mjs';
import {studioFixture} from './script-project.test.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
function episode(text = 'Hello, <b>friend</b> & team.') {
  return createScriptEpisode({...studioFixture(), settings: {...DEFAULT_SCRIPT_SETTINGS, text}});
}

test('SRT and VTT preserve absolute half-open caption boundaries and literal text', () => {
  const source = episode();
  const original = JSON.stringify(source);
  const {srt, vtt} = renderSubtitleSidecars(source);
  const first = source.dialogue.captions[0];
  const boundary = (frame, separator) => {
    const ms = Math.round(frame * 1000 / source.fps);
    return `00:00:${String(Math.floor(ms / 1000)).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`;
  };
  assert.ok(srt.startsWith(`1\n${boundary(first.startFrame, ',')} --> ${boundary(first.endFrame, ',')}\n`));
  assert.ok(vtt.startsWith(`WEBVTT\n\n${boundary(first.startFrame, '.')} --> ${boundary(first.endFrame, '.')}\n`));
  assert.match(srt, /&lt;b&gt;friend&lt;\/b&gt; &amp; team\./);
  assert.match(vtt, /&lt;b&gt;friend&lt;\/b&gt; &amp; team\./);
  assert.equal((srt.match(/ --> /g) || []).length, source.dialogue.captions.length);
  assert.equal((vtt.match(/ --> /g) || []).length, source.dialogue.captions.length);
  assert.equal(JSON.stringify(source), original);
});

test('subtitle exporter rejects absent or invalid dialogue', () => {
  const source = episode();
  delete source.dialogue;
  assert.throws(() => renderSubtitleSidecars(source), /no dialogue captions/);
  source.dialogue = episode().dialogue;
  source.dialogue.captions[0].endFrame = source.durationFrames + 1;
  assert.throws(() => renderSubtitleSidecars(source), /endFrame/);
});

test('sidecar writes refuse overwrites, clean staged files, and allow explicit force', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'narrative-subtitles-'));
  const prefix = path.join(dir, 'take');
  try {
    const first = await writeSubtitleSidecars(episode('First take.'), prefix);
    assert.equal(first.captionCount, 1);
    const priorSrt = await readFile(first.srt, 'utf8');
    const priorVtt = await readFile(first.vtt, 'utf8');
    await assert.rejects(writeSubtitleSidecars(episode('Second take.'), prefix), /EEXIST/);
    assert.equal(await readFile(first.srt, 'utf8'), priorSrt);
    assert.equal(await readFile(first.vtt, 'utf8'), priorVtt);
    await writeSubtitleSidecars(episode('Second take.'), prefix, {force: true});
    assert.match(await readFile(first.srt, 'utf8'), /Second take\./);
    assert.match(await readFile(first.vtt, 'utf8'), /Second take\./);
    assert.deepEqual((await readdir(dir)).sort(), ['take.srt', 'take.vtt']);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('CLI exports a saved episode and rejects a second write', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'narrative-subtitles-cli-'));
  try {
    const input = path.join(dir, 'episode.json');
    const prefix = path.join(dir, 'captions');
    await writeFile(input, JSON.stringify(episode('A saved scene.')));
    const run = () => spawnSync(process.execPath, [path.join(root, 'scripts/export-subtitles.mjs'), input, prefix], {encoding: 'utf8'});
    assert.equal(run().status, 0);
    assert.match(await readFile(`${prefix}.srt`, 'utf8'), /A saved scene\./);
    assert.equal(run().status, 1);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
