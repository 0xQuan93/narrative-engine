import { readFile } from 'node:fs/promises';
import path from 'node:path';

const REQUIRED = [
  ['out/setup/first-take.json', 'Studio default episode'],
  ['assets.lock.json', 'imported avatar lock'],
];

/** The Remotion entry imports these files. A missing file otherwise fails inside the bundler. */
export async function assertStudioBundleInputs(root) {
  const missing = [];
  for (const [relative, role] of REQUIRED) {
    const filename = path.join(root, relative);
    let text;
    try { text = await readFile(filename, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') { missing.push(relative); continue; }
      throw error;
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (error) {
      throw new Error(`${relative} (${role}) is not valid JSON (${error.message}). Run npm run setup again with your VRM and two PoseLab clips.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${relative} (${role}) must be a JSON object. Run npm run setup again with your VRM and two PoseLab clips.`);
    }
  }
  if (missing.length) {
    throw new Error(`Remotion needs ${missing.join(' and ')} before Studio or a CLI render can start. Run npm run setup with your VRM and two PoseLab motion JSON files. The composition imports these files even when --episode points somewhere else.`);
  }
}
