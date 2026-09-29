/**
 * Settings changed from the app (currently the GitHub token), stored next to
 * the database in storage/settings.json. The file holds a secret, so it is
 * written readable by its owner only (0600; on Windows the folder's permissions apply).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const settingsFile = () => path.join(config.paths.storage, 'settings.json');
let cached = null;

export async function readSettings() {
  if (cached) return cached;
  try {
    cached = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
  } catch {
    cached = {};
  }
  return cached;
}

/** Merges `patch` into the settings; null or undefined values remove a key. Written atomically. */
export async function updateSettings(patch) {
  const next = { ...(await readSettings()), ...patch };
  for (const key of Object.keys(next)) if (next[key] === null || next[key] === undefined) delete next[key];
  await fs.mkdir(config.paths.storage, { recursive: true });
  const temporary = `${settingsFile()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.rename(temporary, settingsFile());
  cached = next;
  return next;
}
