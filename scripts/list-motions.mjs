import {readFile, access} from 'node:fs/promises';
import path from 'node:path';

if (!process.argv[2] || process.argv[3]) throw new Error('Usage: npm run motions -- /path/to/poselabstudio');
const root = path.resolve(process.argv[2]);
const directory = path.join(root, 'src/poses');
const source = await readFile(path.join(directory, 'animation-pool.ts'), 'utf8');
// Read the existing declarative catalog; never execute the authoring app.
const entries = [...source.matchAll(/\{ id: '([^']+)', label: '([^']+)', category: '([^']+)', file: '([^']+)' \}/g)];
if (!entries.length) throw new Error('PoseLab catalog layout changed; update the explicit adapter');
const aliases = {'idle-offensive': 'offensive-idle', 'action-defeat': 'defeat'};
const rows = [];
for (const [, id, label, category, filename] of entries) {
  const file = path.join(directory, `${aliases[id] || filename}-animation.json`);
  let available = true;
  try { await access(file); } catch (error) { if (error.code !== 'ENOENT') throw error; available = false; }
  const clip = available ? JSON.parse(await readFile(file, 'utf8')) : null;
  rows.push({id, label, category, seconds: clip ? Number(clip.duration.toFixed(3)) : null,
    status: available ? 'JSON available' : 'JSON absent; FBX adapter needed', file: available ? file : null});
}
console.log(JSON.stringify({catalog: path.join(directory, 'animation-pool.ts'), count: rows.length,
  jsonAvailable: rows.filter((row) => row.file).length, motions: rows}, null, 2));
