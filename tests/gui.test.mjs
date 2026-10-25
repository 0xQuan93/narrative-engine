import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createGuiServer } from '../scripts/gui.mjs';
import { isLiveRenderProcess, pidAlive } from '../src/process-lock.mjs';
import { createScriptEpisode, DEFAULT_SCRIPT_SETTINGS } from '../src/script-project.mjs';
import {executeJob} from '../src/jobs.mjs';
import { studioFixture } from './script-project.test.mjs';

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'narrative-gui-'));
  await mkdir(path.join(root, 'out/setup'), {recursive: true});
  const fixture = studioFixture();
  for (const [file, data] of [['base-episode.json', fixture.baseEpisode], ['wave.sequence.json', fixture.wave], ['idle.sequence.json', fixture.idle]]) await writeFile(path.join(root, 'out/setup', file), JSON.stringify(data));
  await writeFile(path.join(root, 'assets.lock.json'), JSON.stringify({ schema: 'narrative-assets/0.1', assets: {} }));
  return root;
}
function request(server, url, { method = 'GET', body, bodyStream, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = bodyStream || Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
    req.url = url; req.method = method;
    req.headers = { host: '127.0.0.1:18994', origin: 'http://127.0.0.1:18994', 'content-type': 'application/json', ...headers };
    const chunks = [];
    const res = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    res.writeHead = (code, responseHeaders) => { res.statusCode = code; res.headers = responseHeaders; res.headersSent = true; };
    res.on('finish', () => { const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch {} resolve({ code: res.statusCode, data, text, headers: res.headers }); });
    res.on('error', reject);
    server.address = () => ({ port: 18994 }); server.emit('request', req, res);
  });
}
test('studio saves drafts, enforces origin/host/body limits and blocks arbitrary files', async () => {
  const root = await setup(); const server = await createGuiServer({ root, buildUI: false });
  try {
    assert.equal((await request(server, '/api/bootstrap')).code, 200);
    assert.equal((await request(server, '/api/save', { method: 'POST', body: { settings: DEFAULT_SCRIPT_SETTINGS }, headers: { origin: 'https://evil.test' } })).code, 403);
    assert.equal((await request(server, '/api/bootstrap', { headers: { host: 'evil.test:18994' } })).code, 403);
    assert.equal((await request(server, '/api/save', { method: 'POST', body: ' '.repeat(65537) })).code, 413);
    const settings = { ...DEFAULT_SCRIPT_SETTINGS, text: 'Saved draft.' };
    assert.equal((await request(server, '/api/save', { method: 'POST', body: { settings } })).code, 200);
    assert.deepEqual((await request(server, '/api/draft')).data.settings, settings);
    assert.equal((await request(server, '/output/../../package.json')).code, 404);
    const restored = await createGuiServer({ root, buildUI: false });
    assert.deepEqual((await request(restored, '/api/bootstrap')).data.settings, settings);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('unfinished storyboard can be saved and restored before it can render', async () => {
  const root = await setup(); const server = await createGuiServer({root, buildUI: false});
  const settings = {...DEFAULT_SCRIPT_SETTINGS, text: 'An unfinished first scene.', camera: 'storyboard'};
  try {
    assert.equal((await request(server, '/api/save', {method: 'POST', body: {settings}})).code, 200);
    assert.equal((await request(server, '/api/render', {method: 'POST', body: {settings}})).code, 400);
    const restored = await createGuiServer({root, buildUI: false});
    assert.deepEqual((await request(restored, '/api/bootstrap')).data.settings, settings);
  } finally { await rm(root, {recursive: true, force: true}); }
});
test('restarting after a verified render receipt recovers missing subtitle sidecars', async () => {
  const root = await setup(), id = '00000000-0000-4000-8000-000000000001';
  const dir = path.join(root, 'out/studio', id); await mkdir(dir, {recursive: true});
  const fixture = studioFixture();
  const episode = createScriptEpisode({...fixture, settings: DEFAULT_SCRIPT_SETTINGS});
  await writeFile(path.join(dir, 'episode.json'), JSON.stringify(episode));
  await writeFile(path.join(dir, 'job.json'), JSON.stringify({id, status: 'running', pid: 99999999, createdAt: '2026-01-01'}));
  await executeJob({outputPath: path.join(dir, 'video.mp4'), identity: 'recovery', inputs: {}, render: (file) => writeFile(file, 'rendered-video')});
  const server = await createGuiServer({root, buildUI: false});
  try {
    const job = (await request(server, `/api/jobs/${id}`)).data;
    assert.equal(job.status, 'completed');
    assert.equal(job.srtUrl, `/output/${id}/captions.srt`);
    assert.match((await request(server, job.vttUrl)).text, /^WEBVTT/);
  } finally { await rm(root, {recursive: true, force: true}); }
});
test('studio starts one immutable render and records renderer failures', async () => {
  const root = await setup(); const child = new EventEmitter(); let spawned;
  const server = await createGuiServer({ root, buildUI: false, spawnRender: (...args) => { spawned = args; return child; } });
  try {
    const settings = { ...DEFAULT_SCRIPT_SETTINGS, camera: 'directed', format: 'portrait' };
    const response = await request(server, '/api/render', { method: 'POST', body: { settings } });
    assert.equal(response.code, 202);
    const { id } = response.data;
    assert.ok(spawned[1].includes('--verify-frames'));
    assert.deepEqual(spawned[1].slice(spawned[1].indexOf('--width'), spawned[1].indexOf('--width') + 4), ['--width', '720', '--height', '1280']);
    const episode = JSON.parse(await readFile(path.join(root, 'out/studio', id, 'episode.json')));
    assert.equal(episode.dialogue.actorId, 'performer');
    assert.equal(episode.environment, 'depth-studio');
    assert.equal((await request(server, '/api/render', { method: 'POST', body: { settings: DEFAULT_SCRIPT_SETTINGS } })).code, 409);
    child.emit('close', 1);
    let job;
    for (let i = 0; i < 100; i++) { job = (await request(server, `/api/jobs/${id}`)).data; if (job.status === 'failed') break; await new Promise((resolve) => setImmediate(resolve)); }
    assert.equal(job.status, 'failed');
    assert.equal((await request(server, `/output/${id}/video.mp4`)).code, 409);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('concurrent slow-body render requests reserve only one worker', async () => {
  const root = await setup(); const child = new EventEmitter(); let count = 0;
  const server = await createGuiServer({ root, buildUI: false, spawnRender: () => { count++; return child; } });
  try {
    let release; const gate = new Promise((resolve) => { release = resolve; });
    const stream = () => Readable.from((async function* () { await gate; yield JSON.stringify({ settings: DEFAULT_SCRIPT_SETTINGS }); })());
    const first = request(server, '/api/render', { method: 'POST', bodyStream: stream() });
    const second = request(server, '/api/render', { method: 'POST', bodyStream: stream() });
    release();
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map((r) => r.code).sort(), [202, 409]);
    assert.equal(count, 1);
    const id = responses.find((r) => r.code === 202).data.id;
    child.emit('close', 1);
    for (let i = 0; i < 100; i++) { if ((await request(server, `/api/jobs/${id}`)).data.status === 'failed') break; await new Promise((resolve) => setImmediate(resolve)); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('constructing a second server does not mutate existing jobs; completed video supports byte ranges', async () => {
  const root = await setup(), id = '00000000-0000-4000-8000-000000000000';
  const dir = path.join(root, 'out/studio', id); await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'job.json');
  await writeFile(file, JSON.stringify({ id, status: 'running', pid: 99999999, createdAt: '2026-01-01' }));
  const before = await readFile(file, 'utf8');
  const server = await createGuiServer({ root, buildUI: false });
  try {
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal((await request(server, `/api/jobs/${id}`)).data.status, 'failed');
    await writeFile(file, JSON.stringify({ id, status: 'completed' }));
    await writeFile(path.join(dir, 'video.mp4'), '0123456789');
    await writeFile(path.join(dir, 'captions.srt'), '1\n00:00:00,000 --> 00:00:01,000\nHello.\n');
    await writeFile(path.join(dir, 'captions.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello.\n');
    assert.equal((await request(server, `/api/jobs/${id}`)).data.srtUrl, `/output/${id}/captions.srt`);
    assert.match((await request(server, `/output/${id}/captions.vtt`)).text, /^WEBVTT/);
    const response = await request(server, `/output/${id}/video.mp4`, { headers: { range: 'bytes=2-5' } });
    assert.equal(response.code, 206); assert.equal(response.text, '2345');
    assert.equal(response.headers['Content-Range'], 'bytes 2-5/10');
    assert.equal((await request(server, `/output/${id}/video.mp4`, { headers: { range: 'bytes=20-' } })).code, 416);
  } finally { await rm(root, { recursive: true, force: true }); }
});
async function fakeRender() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'narrative-gui-render-'));
  const script = path.join(dir, 'scripts/render.mjs');
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, 'setInterval(() => {}, 1 << 30);\n');
  const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
  for (let i = 0; i < 50 && !isLiveRenderProcess(child.pid); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  return { pid: child.pid, async stop() {
    try { if (isLiveRenderProcess(child.pid)) child.kill('SIGKILL'); } catch {}
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  } };
}
test('a reused owner pid does not block Script Studio, and a live renderer does', async () => {
  const root = await setup();
  const staleId = '00000000-0000-4000-8000-000000000010';
  const staleDir = path.join(root, 'out/studio', staleId);
  await mkdir(staleDir, { recursive: true });
  await writeFile(path.join(staleDir, 'job.json'), JSON.stringify({ id: staleId, status: 'running', ownerPid: process.pid, createdAt: '2026-01-01' }));
  const child = new EventEmitter();
  const server = await createGuiServer({ root, buildUI: false, spawnRender: () => child });
  const renderer = await fakeRender();
  const liveId = '00000000-0000-4000-8000-000000000011';
  try {
    assert.equal(isLiveRenderProcess(renderer.pid), true);
    assert.equal((await request(server, '/api/render', { method: 'POST', body: { settings: DEFAULT_SCRIPT_SETTINGS } })).code, 202);
    assert.equal((await request(server, `/api/jobs/${staleId}`)).data.status, 'failed');
    child.emit('close', 1);
    const liveDir = path.join(root, 'out/studio', liveId);
    await mkdir(liveDir, { recursive: true });
    await writeFile(path.join(liveDir, 'job.json'), JSON.stringify({ id: liveId, status: 'running', pid: renderer.pid, createdAt: '2026-01-03' }));
    const restarted = await createGuiServer({ root, buildUI: false, spawnRender: () => new EventEmitter() });
    assert.equal((await request(restarted, '/api/render', { method: 'POST', body: { settings: DEFAULT_SCRIPT_SETTINGS } })).code, 409);
    await renderer.stop();
    for (let i = 0; i < 50 && pidAlive(renderer.pid); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await request(restarted, `/api/jobs/${liveId}`)).data.status, 'failed');
    const after = await request(restarted, '/api/render', { method: 'POST', body: { settings: DEFAULT_SCRIPT_SETTINGS } });
    assert.equal(after.code, 202);
    restarted.stopActiveWork();
  } finally { await renderer.stop(); await rm(root, { recursive: true, force: true }); }
});
test('stopping Script Studio signals the detached render process group', async () => {
  const root = await setup();
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const server = await createGuiServer({ root, buildUI: false, spawnRender: () => child });
  try {
    assert.equal((await request(server, '/api/render', { method: 'POST', body: { settings: DEFAULT_SCRIPT_SETTINGS } })).code, 202);
    assert.equal(pidAlive(child.pid), true);
    server.stopActiveWork();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('detached render was not stopped')), 1000)),
    ]);
    assert.equal(pidAlive(child.pid), false);
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});
