import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { samplePoseLabClip } from './poselab.mjs';

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const fail = (message) => { throw new Error(`PoseLab import: ${message}`); };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function atomicWrite(filename, bytes) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, filename); }
  finally { await rm(temporary, { force: true }); }
}

/** Write canonical sequence and deterministic .source.json provenance sibling. */
export async function importPoseLabFile(sourcePath, outputPath, options) {
  const source = path.resolve(sourcePath);
  const output = path.resolve(outputPath);
  if (!output.endsWith('.json')) fail('output must end with .json');
  const provenancePath = output.slice(0, -5) + '.source.json';
  if (source === output || source === provenancePath) fail('output must not overwrite the source bank file');
  const info = await stat(source);
  if (!info.isFile() || info.size > MAX_SOURCE_BYTES) fail('source must be a JSON file no larger than 32 MiB');
  const bytes = await readFile(source);
  if (bytes.length > MAX_SOURCE_BYTES) fail('source exceeds 32 MiB');
  let clip;
  try { clip = JSON.parse(bytes.toString('utf8')); } catch { fail('invalid source JSON'); }
  const { sequence, summary } = samplePoseLabClip(clip, options);
  const serialized = JSON.stringify(sequence) + '\n';
  const provenance = {
    schema: 'narrative-motion-source/0.1',
    sourceFile: path.basename(source),
    sourceSha256: hash(bytes),
    sourceBytes: bytes.length,
    outputFile: path.basename(output),
    outputSha256: hash(serialized),
    ...summary,
  };
  await atomicWrite(output, serialized);
  await atomicWrite(provenancePath, JSON.stringify(provenance, null, 2) + '\n');
  return { output, provenancePath, provenance };
}
