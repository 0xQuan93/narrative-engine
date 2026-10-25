#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowserExecutable } from '../src/browser-executable.mjs';
import { assertStudioBundleInputs } from '../src/studio-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  await assertStudioBundleInputs(root);
  resolveBrowserExecutable();
  const child = spawn(path.join(root, 'node_modules/.bin/remotion'), ['studio', 'src/render/index.jsx', '--no-open'], { cwd: root, stdio: 'inherit' });
  child.on('error', (error) => { console.error(error.message); process.exit(1); });
  child.on('exit', (code) => { process.exit(code ?? 1); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
