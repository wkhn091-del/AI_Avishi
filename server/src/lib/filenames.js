/**
 * Helpers for handling client-supplied filenames safely.
 * Stored files always get server-generated names (UUID + safe extension);
 * the original name is kept only as display metadata.
 */
import path from 'node:path';

/** Lower-cased extension usable in a stored filename, or '' if it looks unsafe. */
export function safeExtension(filename) {
  const extension = path.extname(filename || '').toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '';
}

/** Strips directories and control characters from a client filename for display. */
export function displayName(filename, fallback = 'untitled') {
  const base = String(filename || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return base.slice(0, 255) || fallback;
}
