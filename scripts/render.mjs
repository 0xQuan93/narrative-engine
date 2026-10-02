#!/usr/bin/env node
import { readFile, open, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { evaluateEpisodeAtFrame } from '../src/episode.mjs';
import { sha256, canonical, hashFile, verifyAssets, sourceHashes, jobIdentity, reusableReceipt, recoverPublication, executeJob } from '../src/jobs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const encoding = {codec: 'h264', pixelFormat: 'yuv420p', imageFormat: 'png', colorSpace: 'bt709', crf: 18, muted: true};
const usage = 'node scripts/render.mjs --episode <json> --out <mp4|png> [--width 1280 --height 720 --concurrency 1] [--frames 0-59 | --still 60] [--verify-frames] [--force]';
async function main() {
  const args = process.argv.slice(2), options = {};
  const allowed = new Set(['episode', 'out', 'width', 'height', 'concurrency', 'frames', 'still', 'assets-lock']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (['--force', '--verify-frames'].includes(args[i])) { options[key] = true; continue; }
    if (!args[i].startsWith('--') || !allowed.has(key) || Object.hasOwn(options, key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(usage);
    options[key] = args[++i];
  }
  if (!options.episode || !options.out || options.frames && options.still !== undefined) throw new Error(usage);
  const integer = (value, name, min, max) => {
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${name}`);
    return Number(value);
  };
  const width = integer(options.width ?? 1280, 'width', 16, 7680);
  const height = integer(options.height ?? 720, 'height', 16, 4320);
  if (width % 2 || height % 2) throw new Error('Dimensions must be even');
  const concurrency = integer(options.concurrency ?? 1, 'concurrency', 1, 16);
  const browserExecutable = process.env.NARRATIVE_BROWSER || '/usr/bin/chromium';
  if (!path.isAbsolute(browserExecutable)) throw new Error('NARRATIVE_BROWSER must be absolute');
  const gl = process.env.NARRATIVE_GL || 'angle';
  if (!['angle', 'angle-egl', 'swiftshader', 'swangle', 'egl', 'vulkan'].includes(gl)) throw new Error('Invalid NARRATIVE_GL');
  const browserVersion = spawnSync(browserExecutable, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (browserVersion.status !== 0) throw new Error('Browser executable could not report its version');
  const episodePath = path.resolve(options.episode);
  const lockPath = path.resolve(options['assets-lock'] || path.join(root, 'assets.lock.json'));
  const outputPath = path.resolve(options.out);
  const still = options.still !== undefined;
  if (path.extname(outputPath).toLowerCase() !== (still ? '.png' : '.mp4')) throw new Error(still ? 'Still output must end in .png' : 'Video output must end in .mp4');
  async function inspect() {
    const raw = await readFile(episodePath);
    const episode = JSON.parse(raw);
    evaluateEpisodeAtFrame(episode, 0);
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const assets = await verifyAssets(lock, path.join(root, 'public'), episode.actors.map((actor) => actor.assetId));
    const frame = still ? integer(options.still, 'still frame', 0, episode.durationFrames - 1) : undefined;
    let frameRange;
    if (options.frames) {
      if (!/^\d+-\d+$/.test(options.frames)) throw new Error('Expected --frames start-end');
      frameRange = options.frames.split('-').map((n) => integer(n, 'frame range', 0, episode.durationFrames - 1));
      if (frameRange[0] > frameRange[1]) throw new Error('Reversed frame range');
    }
    const inputs = { episodeRawSha256: sha256(raw), episodeCanonicalSha256: sha256(canonical(episode)), assets, sources: await sourceHashes(root), runtime: { node: process.version, platform: process.platform, arch: process.arch, browserExecutable, browserSha256: await hashFile(browserExecutable), browserVersion: browserVersion.stdout.trim() }, render: { compositionId: 'NarrativeEpisode', width, height, concurrency, gl, verifyFrameOrder: Boolean(options['verify-frames']), mode: still ? 'still' : 'video', frame: frame ?? null, frameRange: frameRange ?? null, ...encoding } };
    return { episode, assets, inputs, identity: jobIdentity(inputs), frame, frameRange };
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  const guardPath = `${outputPath}.render.lock`;
  const guard = await open(guardPath, 'wx').catch((error) => { if (error.code === 'EEXIST') throw new Error(`Output is locked: ${guardPath}. Check for an active renderer before removing a stale lock.`); throw error; });
  try {
    await guard.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await recoverPublication(outputPath);
    const snapshot = await inspect();
    const cached = await reusableReceipt(`${outputPath}.receipt.json`, outputPath, snapshot.identity);
    if (cached && !options.force) { console.log(`Verified cached render: ${outputPath}`); return; }
    const logPath = `${outputPath}.render.log`;
    const log = await open(logPath, 'a');
    try {
      const logLine = async (message) => { await log.write(`${new Date().toISOString()} ${message}\n`); };
      await logLine(`Start ${snapshot.identity}`);
      await executeJob({ outputPath, identity: snapshot.identity, inputs: snapshot.inputs,
        verifyUnchanged: async () => { if ((await inspect()).identity !== snapshot.identity) throw new Error('Inputs changed during rendering; output was not published'); },
        render: async (partial) => {
          const [{ bundle }, { selectComposition, renderMedia, renderStill }] = await Promise.all([import('@remotion/bundler'), import('@remotion/renderer')]);
          const serveUrl = await bundle({ entryPoint: path.join(root, 'src/render/index.jsx'), publicDir: path.join(root, 'public') });
          try {
            const inputProps = { episode: snapshot.episode, assets: snapshot.assets, width, height, verifyFrameOrder: Boolean(options['verify-frames']) };
            const chromiumOptions = { gl };
            const verification = [];
            const onBrowserLog = (entry) => {
              void logLine(`[browser:${entry.type}] ${entry.text}`).catch(() => {});
              const prefix = 'NARRATIVE_FRAME_VERIFICATION ';
              if (entry.text.startsWith(prefix)) {
                try { verification.push(JSON.parse(entry.text.slice(prefix.length))); } catch {}
              }
            };
            const selected = await selectComposition({ serveUrl, id: 'NarrativeEpisode', inputProps, browserExecutable, chromiumOptions, timeoutInMilliseconds: 120000, onBrowserLog });
            const composition = { ...selected, width, height };
            const common = { serveUrl, composition, inputProps, browserExecutable, chromiumOptions, timeoutInMilliseconds: 120000, onBrowserLog };
            if (still) await renderStill({ ...common, output: partial, frame: snapshot.frame, imageFormat: 'png' });
            else await renderMedia({ ...common, outputLocation: partial, ...encoding, concurrency, frameRange: snapshot.frameRange });
            if (options['verify-frames'] && verification.length === 0) throw new Error('Renderer did not emit required frame verification');
            if (verification.some((entry) => entry?.passed !== true)) throw new Error('Renderer frame verification did not pass');
            return verification.length ? { verification } : undefined;
          } finally { await rm(serveUrl, { recursive: true, force: true }); }
        },
      });
      await logLine('Completed');
      console.log(`Rendered: ${outputPath}`);
    } catch (error) { await log.write(`${error.stack || error}\n`); throw error; }
    finally { await log.close(); }
  } finally { await guard.close(); await rm(guardPath, { force: true }); }
}
main().catch((error) => { console.error(`Render failed: ${error.message}`); process.exitCode = 1; });
