#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, readdir, open, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { atomicJson, reusableReceipt } from '../src/jobs.mjs';
import { isLiveRenderProcess } from '../src/process-lock.mjs';
import { createScriptEpisode, validateScriptSettings, DEFAULT_SCRIPT_SETTINGS } from '../src/script-project.mjs';
import { writeSubtitleSidecars } from '../src/subtitles.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID = /^[a-f0-9-]{36}$/;
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
async function loadJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function bodyJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Expected application/json'), { status: 415 });
  const parts = []; let size = 0;
  for await (const part of req) { const bytes = Buffer.from(part); size += bytes.length; if (size > 65536) throw Object.assign(new Error('Request body exceeds 64KiB'), { status: 413 }); parts.push(bytes); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new Error('Invalid JSON'); }
}
async function serveFile(req, res, filename, mime) {
  let info;
  try { info = await stat(filename); } catch (error) { if (error.code === 'ENOENT') return json(res, 404, { error: 'Not found' }); throw error; }
  if (!info.isFile()) return json(res, 404, { error: 'Not found' });
  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  let start = 0, end = info.size - 1;
  if (req.headers.range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    if (!match) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
    start = Number(match[1]); end = match[2] ? Number(match[2]) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
    end = Math.min(end, info.size - 1); headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length'] = String(Math.max(0, end - start + 1));
  res.writeHead(req.headers.range ? 206 : 200, headers);
  if (req.method === 'HEAD' || !info.size) return res.end();
  const stream = createReadStream(filename, { start, end }); stream.on('error', () => res.destroy()); stream.pipe(res);
}

export async function createGuiServer({ root = DEFAULT_ROOT, buildUI = true, spawnRender = spawn } = {}) {
  root = path.resolve(root);
  const studio = path.join(root, 'out/studio');
  await mkdir(studio, { recursive: true });
  const draftPath = path.join(studio, 'draft.json');
  let baseEpisode, wave, idle, lock;
  try {
    [baseEpisode, wave, idle, lock] = await Promise.all([
      loadJson(path.join(root, 'out/setup/base-episode.json')), loadJson(path.join(root, 'out/setup/wave.sequence.json')),
      loadJson(path.join(root, 'out/setup/idle.sequence.json')), loadJson(path.join(root, 'assets.lock.json')),
    ]);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Run npm run setup with your licensed VRM and two PoseLab motion JSON files before opening Script Studio');
    throw error;
  }
  let saved = { ...DEFAULT_SCRIPT_SETTINGS }, active = null, latest = null;
  try { saved = validateScriptSettings((await loadJson(draftPath)).settings); } catch {}
  let recovered = null;
  for (const id of (await readdir(studio)).filter((name) => ID.test(name))) {
    try {
      const file = path.join(studio, id, 'job.json'); const job = await loadJson(file);
      if (['running', 'queued'].includes(job.status) && isLiveRenderProcess(job.pid)
          && (!recovered || (job.createdAt || '') > recovered.createdAt)) {
        recovered = { id, child: null, pid: job.pid, createdAt: job.createdAt || '' };
      }
      if (!latest || (job.createdAt || '') > latest.createdAt) latest = { id, createdAt: job.createdAt || '' };
    } catch {}
  }
  if (recovered) active = recovered;
  if (buildUI) {
    const { build } = await import('esbuild');
    await build({ entryPoints: [path.join(root, 'src/ui/index.jsx')], outfile: path.join(root, '.cache/gui/app.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' });
  }
  const ensureSidecars = async (id, episode) => {
    const dir = path.join(studio, id);
    try { await Promise.all(['srt', 'vtt'].map((extension) => stat(path.join(dir, `captions.${extension}`)))); return; } catch {}
    await writeSubtitleSidecars(episode ?? await loadJson(path.join(dir, 'episode.json')), path.join(dir, 'captions'), {force: true});
  };
  const jobResponse = async (id) => {
    let job = await loadJson(path.join(studio, id, 'job.json'));
    const trackedHere = active?.id === id;
    const startingHere = trackedHere && !active.child && !Number.isInteger(job.pid);
    if (['running', 'queued'].includes(job.status) && !(trackedHere && active.child)) {
      const outputPath = path.join(studio, id, 'video.mp4');
      let receipt; try { receipt = await loadJson(`${outputPath}.receipt.json`); } catch {}
      if (receipt?.status === 'completed' && await reusableReceipt(`${outputPath}.receipt.json`, outputPath, receipt.identity)) {
        try { await ensureSidecars(id); job = { ...job, status: 'completed', finishedAt: new Date().toISOString() }; }
        catch (error) { job = { ...job, status: 'failed', error: `Subtitle recovery failed: ${error.message}`, finishedAt: new Date().toISOString() }; }
      }
      else if (!startingHere && !isLiveRenderProcess(job.pid)) job = { ...job, status: 'failed', error: 'Render process ended without a verified output', finishedAt: new Date().toISOString() };
      if (job.status !== 'running' && job.status !== 'queued') { await atomicJson(path.join(studio, id, 'job.json'), job); if (active?.id === id) active = null; }
    }
    const result = { id, status: job.status, error: job.error, createdAt: job.createdAt, settings: job.settings };
    if (job.status === 'completed') {
      result.videoUrl = `/output/${id}/video.mp4`; result.receiptUrl = `/output/${id}/receipt.json`;
      try {
        await Promise.all(['srt', 'vtt'].map((extension) => stat(path.join(studio, id, `captions.${extension}`))));
        result.srtUrl = `/output/${id}/captions.srt`; result.vttUrl = `/output/${id}/captions.vtt`;
      } catch {}
    }
    return result;
  };
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      const expectedPort = server.address()?.port;
      if (![ `127.0.0.1:${expectedPort}`, `localhost:${expectedPort}` ].includes(host)) return json(res, 403, { error: 'Loopback host required' });
      if (req.method === 'POST' && req.headers.origin !== `http://${host}`) return json(res, 403, { error: 'Same-origin request required' });
      const url = new URL(req.url, `http://${host}`), route = url.pathname;
      if (req.method === 'GET' && route === '/api/bootstrap') return json(res, 200, { baseEpisode, wave, idle, assets: lock.assets, settings: saved, latest: latest ? await jobResponse(latest.id) : null });
      if (req.method === 'GET' && route === '/api/draft') return json(res, 200, { settings: saved });
      if (req.method === 'POST' && ['/api/save', '/api/render'].includes(route)) {
        if (active && !active.child) await jobResponse(active.id);
        if (route === '/api/render' && active) return json(res, 409, { error: 'A render is already running', id: active.id });
        const body = await bodyJson(req);
        if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'settings')) throw new Error('Expected {settings}');
        const settings = validateScriptSettings(body.settings);
        if (route === '/api/save') { await atomicJson(draftPath, { settings }); saved = settings; return json(res, 200, { settings }); }
        const episode = createScriptEpisode({ baseEpisode, wave, idle, settings });
        if (active) return json(res, 409, { error: 'A render is already running', id: active.id });
        // Reserve before the first write so concurrent HTTP requests cannot start another job.
        const id = randomUUID(); active = { id, child: null }; const dir = path.join(studio, id);
        let log;
        try {
          await mkdir(dir, { recursive: false });
          const episodePath = path.join(dir, 'episode.json'), outputPath = path.join(dir, 'video.mp4');
          await writeFile(episodePath, JSON.stringify(episode), { flag: 'wx' });
          const job = { id, status: 'running', settings, ownerPid: process.pid, createdAt: new Date().toISOString() };
          await atomicJson(path.join(dir, 'job.json'), job);
          await atomicJson(draftPath, { settings }); saved = settings; latest = { id, createdAt: job.createdAt };
          log = await open(path.join(dir, 'render.log'), 'a');
          const portrait = settings.format === 'portrait';
          const child = spawnRender(process.execPath, [path.join(root, 'scripts/render.mjs'), '--episode', episodePath, '--out', outputPath,
            '--width', String(portrait ? 720 : 1280), '--height', String(portrait ? 1280 : 720),
            '--verify-frames', '--concurrency', '1'], { cwd: root, stdio: ['ignore', log.fd, log.fd], detached: true });
          active.child = child;
          if (Number.isInteger(child.pid)) job.pid = child.pid;
          const pidPersistence = atomicJson(path.join(dir, 'job.json'), job);
          let finished = false;
          const finish = async (code, error) => {
            if (finished) return; finished = true;
            try {
              await pidPersistence;
              let receipt;
              if (code === 0 && !error) {
                receipt = await loadJson(`${outputPath}.receipt.json`);
                if (!await reusableReceipt(`${outputPath}.receipt.json`, outputPath, receipt.identity)) throw new Error('Render output failed receipt verification');
                await ensureSidecars(id, episode);
              }
              await atomicJson(path.join(dir, 'job.json'), { ...job, status: receipt ? 'completed' : 'failed', ...(receipt ? {} : { error: String(error?.message || `Renderer exited with code ${code}`) }), finishedAt: new Date().toISOString() });
            } catch (failure) { await atomicJson(path.join(dir, 'job.json'), { ...job, status: 'failed', error: failure.message, finishedAt: new Date().toISOString() }).catch(() => {}); }
            finally { await log.close().catch(() => {}); if (active?.id === id) active = null; }
          };
          child.once('error', (error) => { void finish(null, error); });
          child.once('close', (code) => { void finish(code); });
          await pidPersistence;
          return json(res, 202, { id, status: 'running' });
        } catch (error) { if (log) await log.close().catch(() => {}); active = null; await atomicJson(path.join(dir, 'job.json'), { id, status: 'failed', settings, error: error.message, createdAt: new Date().toISOString() }).catch(() => {}); throw error; }
      }
      const jobMatch = /^\/api\/jobs\/([a-f0-9-]{36})$/.exec(route);
      if (req.method === 'GET' && jobMatch) return json(res, 200, await jobResponse(jobMatch[1]));
      if (['GET', 'HEAD'].includes(req.method)) {
        if (route === '/fonts/LiberationSans-Bold.ttf') return await serveFile(req, res, path.join(root, 'public/fonts/LiberationSans-Bold.ttf'), 'font/ttf');
        const assetMatch = /^\/assets\/([a-f0-9]{64}\.vrm)$/.exec(route);
        if (assetMatch && Object.values(lock.assets).some((asset) => asset.file === `assets/${assetMatch[1]}`)) return await serveFile(req, res, path.join(root, 'public/assets', assetMatch[1]), 'model/gltf-binary');
        const outputMatch = /^\/output\/([a-f0-9-]{36})\/(video\.mp4|receipt\.json|captions\.srt|captions\.vtt)$/.exec(route);
        if (outputMatch) {
          const job = await jobResponse(outputMatch[1]);
          if (job.status !== 'completed') return json(res, 409, { error: 'Render is not complete' });
          const files = {'video.mp4': ['video.mp4', 'video/mp4'], 'receipt.json': ['video.mp4.receipt.json', 'application/json'],
            'captions.srt': ['captions.srt', 'application/x-subrip'], 'captions.vtt': ['captions.vtt', 'text/vtt']};
          const [file, mime] = files[outputMatch[2]];
          return await serveFile(req, res, path.join(studio, outputMatch[1], file), mime);
        }
        const files = { '/app.js': ['.cache/gui/app.js', 'text/javascript'], '/app.css': ['.cache/gui/app.css', 'text/css'], '/styles.css': ['src/ui/styles.css', 'text/css'] };
        if (files[route]) return await serveFile(req, res, path.join(root, files[route][0]), files[route][1]);
        if (route === '/') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Script Studio</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>'); }
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) { if (!res.headersSent) json(res, error.status || (error.code === 'ENOENT' ? 404 : 400), { error: error.message }); else res.destroy(); }
  });
  const signalGroup = (pid) => {
    try { process.kill(-pid, 'SIGTERM'); }
    catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  };
  server.stopActiveWork = () => {
    const childPid = active?.child?.pid;
    if (Number.isInteger(childPid) && childPid > 0) { signalGroup(childPid); return; }
    if (isLiveRenderProcess(active?.pid)) signalGroup(active.pid);
  };
  server.on('close', () => { server.stopActiveWork(); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.NARRATIVE_GUI_PORT || 18994);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid NARRATIVE_GUI_PORT');
  const server = await createGuiServer();
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  let shuttingDown = false;
  const shutdown = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.stopActiveWork();
    const timer = setTimeout(() => process.exit(code), 1000);
    timer.unref();
    server.close(() => process.exit(code));
  };
  process.once('SIGINT', () => shutdown(130));
  process.once('SIGTERM', () => shutdown(143));
  server.listen(port, '127.0.0.1', () => console.log(`Script Studio: http://127.0.0.1:${port}/`));
}
