import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveBrowserExecutable } from '../src/browser-executable.mjs';

async function bin(dir, name) {
  const filename = path.join(dir, name);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, '#!/bin/sh\nexit 0\n');
  await chmod(filename, 0o755);
  return filename;
}

test('browser search prefers chromium, honors an absolute override, and reports a miss', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'narrative-browser-'));
  try {
    const chromium = await bin(dir, 'usr/bin/chromium');
    const chrome = await bin(dir, 'usr/bin/google-chrome');
    const candidates = [chromium, path.join(dir, 'missing'), chrome];
    assert.equal(resolveBrowserExecutable({ env: {}, candidates, pathValue: '' }), chromium);
    assert.equal(resolveBrowserExecutable({ env: { NARRATIVE_BROWSER: chrome }, candidates, pathValue: '' }), chrome);
    assert.throws(() => resolveBrowserExecutable({ env: { NARRATIVE_BROWSER: 'chromium' }, candidates, pathValue: dir }), /absolute path/);
    await mkdir(path.join(dir, 'empty-dir'));
    assert.throws(() => resolveBrowserExecutable({ env: { NARRATIVE_BROWSER: path.join(dir, 'empty-dir') }, candidates, pathValue: '' }), /not an executable file/);
    const pathOnly = await bin(dir, 'bin/chromium');
    assert.equal(resolveBrowserExecutable({ env: {}, candidates: [path.join(dir, 'absent')], pathValue: path.dirname(pathOnly), names: ['chromium'] }), pathOnly);
    const link = path.join(dir, 'linked-chrome');
    await symlink(chrome, link);
    assert.equal(resolveBrowserExecutable({ env: { NARRATIVE_BROWSER: link }, candidates, pathValue: '' }), link);
    assert.throws(() => resolveBrowserExecutable({ env: {}, candidates: [path.join(dir, 'absent')], pathValue: '', names: [] }), /NARRATIVE_BROWSER/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
