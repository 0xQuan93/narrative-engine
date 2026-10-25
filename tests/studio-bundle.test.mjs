import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertStudioBundleInputs } from '../src/studio-bundle.mjs';

test('Remotion preflight names missing setup files and rejects corrupt JSON', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'narrative-studio-bundle-'));
  try {
    await assert.rejects(assertStudioBundleInputs(root), /out\/setup\/first-take\.json and assets\.lock\.json/);
    await assert.rejects(assertStudioBundleInputs(root), /--episode/);
    await mkdir(path.join(root, 'out/setup'), { recursive: true });
    await writeFile(path.join(root, 'out/setup/first-take.json'), '{');
    await writeFile(path.join(root, 'assets.lock.json'), '{}');
    await assert.rejects(assertStudioBundleInputs(root), /not valid JSON/);
    await writeFile(path.join(root, 'out/setup/first-take.json'), '[]');
    await assert.rejects(assertStudioBundleInputs(root), /JSON object/);
    await writeFile(path.join(root, 'out/setup/first-take.json'), '{"schema":"narrative-episode/0.1"}');
    await assert.doesNotReject(assertStudioBundleInputs(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});
