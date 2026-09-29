/**
 * A tar archive (POSIX ustar) of text files: the project goes into a Docker sandbox in one stream,
 * extracted there by the sandbox's own user, so every file belongs to it.
 */
const BLOCK = 512;

function field(buffer, text, offset, length) {
  buffer.write(text, offset, Math.min(Buffer.byteLength(text), length), 'utf8');
}
const octal = (value, length) => `${value.toString(8).padStart(length - 1, '0')}\0`;

/** Splits a path the ustar way: at most 100 bytes of name, and the folders (up to 155) in the prefix. */
function splitPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let index = path.indexOf('/'); index !== -1; index = path.indexOf('/', index + 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`The path is too long for a tar archive: ${path}`);
}

function header(path, size, mtime) {
  const buffer = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitPath(path);
  field(buffer, name, 0, 100);
  field(buffer, octal(0o644, 8), 100, 8);
  field(buffer, octal(1000, 8), 108, 8);
  field(buffer, octal(1000, 8), 116, 8);
  field(buffer, octal(size, 12), 124, 12);
  field(buffer, octal(mtime, 12), 136, 12);
  buffer.fill(' ', 148, 156);
  field(buffer, '0', 156, 1);
  field(buffer, 'ustar\0', 257, 6);
  field(buffer, '00', 263, 2);
  field(buffer, 'node', 265, 32);
  field(buffer, 'node', 297, 32);
  field(buffer, prefix, 345, 155);
  let sum = 0;
  for (const byte of buffer) sum += byte;
  field(buffer, `${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return buffer;
}

/** @param {Iterable<[string, string]>} files  path → text */
export function tarOf(files, mtime = Math.floor(Date.now() / 1000)) {
  const parts = [];
  for (const [path, content] of files) {
    const data = Buffer.from(String(content), 'utf8');
    parts.push(header(path, data.length, mtime), data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}
