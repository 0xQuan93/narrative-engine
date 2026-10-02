import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, readdir, realpath, stat, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const jobIdentity = (inputs) => sha256(canonical(inputs));
export async function atomicJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}
export async function hashFile(filename) { return sha256(await readFile(filename)); }

export async function verifyAssets(lock, publicRoot, assetIds) {
  if (lock?.schema !== 'narrative-assets/0.1' || !lock.assets || Array.isArray(lock.assets)) throw new Error('Unsupported asset lock');
  const root = await realpath(publicRoot);
  const verified = {};
  for (const id of [...new Set(assetIds)].sort()) {
    const asset = lock.assets[id];
    if (!asset || typeof asset.file !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1) throw new Error(`Invalid locked asset: ${id}`);
    if (path.isAbsolute(asset.file) || asset.file.includes('\\') || asset.file.split('/').some((part) => part === '..' || !part) || /^[a-z]+:/i.test(asset.file)) throw new Error(`Unsafe asset path: ${id}`);
    const filename = await realpath(path.join(root, asset.file));
    if (!filename.startsWith(`${root}${path.sep}`)) throw new Error(`Asset escaped public root: ${id}`);
    const bytes = await readFile(filename);
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) throw new Error(`Asset hash/size mismatch: ${id}`);
    verified[id] = asset;
  }
  return verified;
}

export async function sourceHashes(root, directories = ['src', 'scripts']) {
  const result = {};
  async function visit(relative) {
    const filename = path.join(root, relative);
    const info = await stat(filename);
    if (info.isDirectory()) {
      for (const entry of (await readdir(filename)).sort()) await visit(path.join(relative, entry));
    } else if (info.isFile()) result[relative.replaceAll(path.sep, '/')] = await hashFile(filename);
  }
  for (const dir of directories) await visit(dir);
  try { await visit('public/fonts'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const file of ['package.json', 'package-lock.json']) await visit(file);
  return result;
}

export async function reusableReceipt(receiptPath, outputPath, identity) {
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (receipt.schema !== 'narrative-render-job/0.1' || receipt.status !== 'completed' || receipt.identity !== identity || receipt.output.path !== path.resolve(outputPath)) return null;
    const output = await readFile(outputPath);
    return output.length === receipt.output.bytes && sha256(output) === receipt.output.sha256 ? receipt : null;
  } catch { return null; }
}

async function optionalCopy(source, destination) {
  try { await copyFile(source, destination); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function restorePublication(publication) {
  for (const [target, backup] of [[publication.outputPath, publication.outputBackup], [`${publication.outputPath}.receipt.json`, publication.receiptBackup]]) {
    if (backup) await copyFile(backup, target);
    else await rm(target, { force: true });
  }
}
async function cleanupPublication(publication) {
  await rm(`${publication.outputPath}.publication.json`, { force: true });
  for (const filename of [publication.outputBackup, publication.receiptBackup]) if (filename) await rm(filename, { force: true });
}
/** Call under the output lock before cache lookup; interrupted pair replacement is recoverable. */
export async function recoverPublication(outputPath) {
  outputPath = path.resolve(outputPath);
  let publication;
  try { publication = JSON.parse(await readFile(`${outputPath}.publication.json`, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (publication.outputPath !== outputPath || !/^[a-f0-9-]{36}$/.test(publication.attemptId)) throw new Error('Invalid publication recovery journal');
  for (const [key, suffix] of [['outputBackup', 'output.bak'], ['receiptBackup', 'receipt.bak']]) {
    if (publication[key] !== null && publication[key] !== `${outputPath}.${publication.attemptId}.${suffix}`) throw new Error('Invalid publication backup path');
  }
  const committed = await reusableReceipt(`${outputPath}.receipt.json`, outputPath, publication.identity);
  if (!committed) await restorePublication(publication);
  await cleanupPublication(publication);
}

/** A worker receives a unique partial filename. Existing outputs survive failures. */
export async function executeJob({ outputPath, identity, inputs, render, verifyUnchanged = async () => {}, onReceipt = () => {}, persist = atomicJson }) {
  outputPath = path.resolve(outputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await recoverPublication(outputPath);
  const attemptId = randomUUID();
  const receiptPath = `${outputPath}.receipt.json`;
  const attemptPath = `${outputPath}.${attemptId}.receipt.json`;
  const extension = path.extname(outputPath);
  const partial = `${outputPath.slice(0, -extension.length || undefined)}.${attemptId}.partial${extension}`;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let receipt = { schema: 'narrative-render-job/0.1', attemptId, identity, status: 'running', startedAt, inputs };
  await persist(attemptPath, receipt);
  // Preserve a previous successful artifact's receipt until replacement succeeds.
  let preserve = false;
  try { preserve = JSON.parse(await readFile(receiptPath, 'utf8')).status === 'completed'; } catch {}
  if (!preserve) await persist(receiptPath, receipt);
  onReceipt(receipt);
  let publication;
  try {
    const result = await render(partial);
    await verifyUnchanged();
    const data = await readFile(partial);
    if (!data.length) throw new Error('Renderer produced an empty output');
    receipt = { ...receipt, status: 'completed', finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), ...(result?.verification ? { verification: result.verification } : {}), output: { path: outputPath, bytes: data.length, sha256: sha256(data) } };
    const outputBackup = `${outputPath}.${attemptId}.output.bak`;
    const receiptBackup = `${outputPath}.${attemptId}.receipt.bak`;
    publication = { schema: 'narrative-publication/0.1', outputPath, attemptId, identity, outputBackup: await optionalCopy(outputPath, outputBackup) ? outputBackup : null, receiptBackup: await optionalCopy(receiptPath, receiptBackup) ? receiptBackup : null };
    await atomicJson(`${outputPath}.publication.json`, publication);
    await rename(partial, outputPath);
    await persist(receiptPath, receipt);
    await persist(attemptPath, receipt);
    // Publication is complete. Cleanup errors leave a journal recoverable on the next run.
    await cleanupPublication(publication).catch(() => {});
    publication = undefined;
    try { onReceipt(receipt); } catch {}
    return receipt;
  } catch (error) {
    if (publication) {
      try { await restorePublication(publication); await cleanupPublication(publication); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], `Publication failed; recovery journal retained at ${outputPath}.publication.json`); }
    }
    receipt = { ...receipt, status: 'failed', finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), error: String(error?.stack || error).slice(0, 16000) };
    delete receipt.output;
    await persist(attemptPath, receipt);
    if (!preserve) await persist(receiptPath, receipt);
    try { onReceipt(receipt); } catch {}
    throw error;
  } finally { await rm(partial, { force: true }); }
}
