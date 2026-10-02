import {spawnSync} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from '../src/jobs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const episode = path.resolve(process.argv[2] || path.join(root, 'out/setup/first-take.json'));
const output = path.resolve(process.argv[3] || path.join(root, 'out/first-take.mp4'));
const run = (command, args, inherit = false) => {
  const result = spawnSync(command, args, {cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    stdio: inherit ? 'inherit' : 'pipe'});
  if (result.error || result.status !== 0) throw new Error(result.error?.message || `${command} failed: ${result.stderr || result.status}`);
  return result.stdout;
};
const args = [path.join(root, 'scripts/render.mjs'), '--episode', episode, '--out', output, '--verify-frames'];
const decodeHashes = () => run('ffmpeg', ['-v', 'error', '-i', output, '-map', '0:v:0', '-f', 'framemd5', '-'])
  .split('\n').filter((line) => line && !line.startsWith('#'));
const receipt = async () => JSON.parse(await readFile(`${output}.receipt.json`, 'utf8'));
const runs = [];
const frames = [];
for (let i = 0; i < 2; i++) {
  console.log(`Fresh render ${i + 1}/2`);
  run(process.execPath, [...args, '--force'], true);
  runs.push(await receipt()); frames.push(decodeHashes());
}
const recipe = JSON.parse(await readFile(episode, 'utf8'));
const media = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]));
const video = media.streams.find((stream) => stream.codec_type === 'video');
const failures = [];
if (runs[0].identity !== runs[1].identity) failures.push('Inputs changed between runs');
if (frames.some((list) => list.length !== recipe.durationFrames)) failures.push('Decoded frame count does not match recipe');
if (JSON.stringify(frames[0]) !== JSON.stringify(frames[1])) failures.push('Decoded video frames differ between fresh renders');
const firstPixels = runs[0].verification?.[0]?.hashes;
const secondPixels = runs[1].verification?.[0]?.hashes;
if (!firstPixels || JSON.stringify(firstPixels) !== JSON.stringify(secondPixels)) failures.push('Fresh-browser RGBA sample hashes differ');
if (media.streams.some((stream) => stream.codec_type === 'audio')) failures.push('Unexpected audio track');
if (video?.r_frame_rate !== `${recipe.fps}/1` || Math.abs(Number(video?.duration) - recipe.durationFrames / recipe.fps) > 1e-6) failures.push('Unexpected video timing');
console.log('Checking verified cache reuse');
run(process.execPath, args, true);
const cached = await receipt();
if (cached.attemptId !== runs[1].attemptId) failures.push('Identical command did not reuse completed output');
const report = {
  schema: 'narrative-render-verification/0.1', passed: failures.length === 0, failures,
  episode, output, identity: runs[1].identity, frames: frames[1].length,
  decodedFramesSha256: sha256(frames[1].join('\n')),
  freshBrowserSampleHashesMatch: Boolean(firstPixels) && JSON.stringify(firstPixels) === JSON.stringify(secondPixels),
  decodedFramesMatch: JSON.stringify(frames[0]) === JSON.stringify(frames[1]),
  mp4BytesMatch: runs[0].output.sha256 === runs[1].output.sha256,
  cacheReused: cached.attemptId === runs[1].attemptId,
  runs: runs.map((entry) => ({attemptId: entry.attemptId, elapsedMs: entry.elapsedMs, sha256: entry.output.sha256})),
  media: {width: video?.width, height: video?.height, fps: video?.r_frame_rate, duration: video?.duration,
    pixelFormat: video?.pix_fmt, colorSpace: video?.color_space, audioStreams: media.streams.filter((s) => s.codec_type === 'audio').length},
  webgl: runs[1].verification?.[0]?.webgl,
};
await writeFile(`${output}.verification.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
