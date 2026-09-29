/** Content types for files served straight from an archive. */

const TYPES = {
  html: 'text/html', htm: 'text/html', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', cjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', xml: 'application/xml',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
  wasm: 'application/wasm', pdf: 'application/pdf', glb: 'model/gltf-binary', gltf: 'model/gltf+json',
  zip: 'application/zip', gz: 'application/gzip',
};

/** Pre-compressed files of Unity/Godot web builds ("Build/game.wasm.gz") are sent with Content-Encoding. */
const PRECOMPRESSED_INNER = new Set(['js', 'wasm', 'data', 'css', 'html', 'json', 'mem', 'pck', 'symbols']);

/**
 * @param {string} filePath e.g. "dist/assets/index.js"
 * @returns {{ type: string, encoding: string|null }}
 */
export function mimeTypeOf(filePath) {
  const name = filePath.split('/').pop().toLowerCase();
  const parts = name.split('.');
  if (parts.length > 2 && parts.at(-1) === 'gz' && PRECOMPRESSED_INNER.has(parts.at(-2))) {
    return { type: TYPES[parts.at(-2)] ?? 'application/octet-stream', encoding: 'gzip' };
  }
  const extension = parts.length > 1 ? parts.at(-1) : '';
  return { type: TYPES[extension] ?? 'application/octet-stream', encoding: null };
}
