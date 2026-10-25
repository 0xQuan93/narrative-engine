import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

export const BROWSER_NAMES = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome'];
export const DEFAULT_BROWSER_CANDIDATES = BROWSER_NAMES.map((name) => path.join('/usr/bin', name));

function executable(file) {
  try {
    if (!path.isAbsolute(file) || !statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch { return false; }
}

/** Prefer Omarchy/Arch Chromium, then other local Chrome builds. NARRATIVE_BROWSER wins when set. */
export function resolveBrowserExecutable({
  env = process.env,
  candidates = DEFAULT_BROWSER_CANDIDATES,
  pathValue = env.PATH,
  names = BROWSER_NAMES,
} = {}) {
  if (env.NARRATIVE_BROWSER) {
    if (!path.isAbsolute(env.NARRATIVE_BROWSER)) throw new Error('NARRATIVE_BROWSER must be an absolute path to Chromium or Chrome');
    if (!executable(env.NARRATIVE_BROWSER)) throw new Error(`NARRATIVE_BROWSER is not an executable file: ${env.NARRATIVE_BROWSER}`);
    return env.NARRATIVE_BROWSER;
  }
  const tried = [];
  const consider = (candidate) => {
    if (tried.includes(candidate)) return false;
    tried.push(candidate);
    return executable(candidate);
  };
  for (const candidate of candidates) if (consider(candidate)) return candidate;
  for (const name of names) {
    for (const dir of String(pathValue || '').split(path.delimiter).filter(Boolean)) {
      if (consider(path.join(dir, name))) return path.join(dir, name);
    }
  }
  throw new Error(`No Chromium or Chrome executable found. Install Chromium (Omarchy uses /usr/bin/chromium) or set NARRATIVE_BROWSER to an absolute path. Tried: ${tried.join(', ')}`);
}
