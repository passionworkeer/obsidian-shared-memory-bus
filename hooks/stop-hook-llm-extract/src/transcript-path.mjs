import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isPathInside(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export function allowedTranscriptRoots({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const roots = new Set();
  const addRoot = (value) => {
    if (value) roots.add(path.resolve(value));
  };

  addRoot(env.CLAUDE_SESSION_DIR);

  const configRoots = [
    env.CLAUDE_CONFIG_DIR,
    path.join(homeDir, '.claude'),
    env.APPDATA ? path.join(env.APPDATA, '.claude') : '',
  ].filter(Boolean);

  for (const configRoot of configRoots) {
    addRoot(path.join(configRoot, 'projects'));
    addRoot(path.join(configRoot, 'sessions'));
  }

  return [...roots];
}

export function validateTranscriptPath(candidatePath, options = {}) {
  if (!candidatePath) return null;

  const resolved = path.resolve(candidatePath);
  if (path.extname(resolved).toLowerCase() !== '.jsonl') return null;
  if (!existsSync(resolved)) return null;

  try {
    if (!statSync(resolved).isFile()) return null;
  } catch {
    return null;
  }

  const roots = allowedTranscriptRoots(options);
  return roots.some((root) => isPathInside(resolved, root)) ? resolved : null;
}
