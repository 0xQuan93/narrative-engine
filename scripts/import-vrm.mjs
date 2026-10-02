#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { importVrm } from '../src/assets.mjs';

const [sourcePath, assetId, ...extra] = process.argv.slice(2);
if (!sourcePath || !assetId || extra.length) {
  console.error('Usage: node scripts/import-vrm.mjs <source.vrm> <asset-id>');
  process.exitCode = 1;
} else {
  try {
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const entry = await importVrm(sourcePath, projectRoot, assetId);
    console.log(JSON.stringify({ assetId, ...entry }, null, 2));
  } catch (error) {
    console.error(`Import failed: ${error.message}`);
    process.exitCode = 1;
  }
}
