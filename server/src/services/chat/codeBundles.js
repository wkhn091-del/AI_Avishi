/**
 * Packages multi-file code answers. A code block belongs to a file when its path
 * is on the opening fence (```jsx src/App.jsx, ```jsx title="src/App.jsx"), on
 * the line just above it (**src/App.jsx**, `src/App.jsx`, ### src/App.jsx,
 * "File: src/App.jsx"), or in a first-line comment (// src/App.jsx). Two or more
 * files make a ZIP, built with adm-zip (the library that already reads project archives).
 */
import AdmZip from 'adm-zip';

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const PATH = /^(?![./])(?!.*\.\.)(?!https?:)[\w@+-][\w@.+-]*(?:\/[\w@.+-]+)*\.[A-Za-z0-9]{1,10}$/;
const SPECIAL = /^(?:[\w@.+-]+\/)*(?:Dockerfile|Makefile|Procfile|LICENSE|\.gitignore|\.env\.example|\.prettierrc|\.eslintrc|\.npmrc|\.nvmrc)$/;
export const isPath = (text) => Boolean(text) && text.length <= 200 && (PATH.test(text) || SPECIAL.test(text));

function pathFromInfo(info) {
  const named = /(?:title|filename|file|path)=["']?([^"'\s]+)["']?/i.exec(info)?.[1];
  if (isPath(named)) return named;
  for (const part of info.trim().split(/\s+/)) {
    const candidate = part.includes(':') ? part.slice(part.indexOf(':') + 1) : part;
    if (isPath(candidate)) return candidate;
  }
  return null;
}

function pathFromLabel(line) {
  const text = line
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/[*_`]/g, '')
    .replace(/^(?:file|path|filename|קובץ|נתיב)\s*[:：]\s*/i, '')
    .replace(/\s*[:：]$/, '')
    .trim();
  return isPath(text) ? text : null;
}

// A later block replaces an earlier one with the same path, unless it's an excerpt ("// ... rest unchanged"):
// a reviewer's partial fix must never overwrite the complete file. Spread syntax (...args) is not an excerpt.
const EXCERPT_LINE = /^\s*(?:(?:\/\/|#|--|;|\/\*|\{\/\*|<!--)\s*)?(?:\.{3}|…)(?![\w$[{(.])/;
const EXCERPT_WORDS = /^\s*(?:\/\/|#|--|;|\/\*|\{\/\*|<!--)\s*(?:(?:the )?rest of (?:the )?(?:file|code|component|module|class)|existing code|(?:code )?unchanged|same as (?:before|above)|שאר הקוד|ללא שינוי)/i;
const isExcerpt = (lines) => lines.some((line) => EXCERPT_LINE.test(line) || EXCERPT_WORDS.test(line));

function pathFromComment(line) {
  const match = /^\s*(?:\/\/|#|--|;|\/\*|<!--)\s*([^\s*]+?)\s*(?:\*\/|-->)?\s*$/.exec(line);
  return match && isPath(match[1]) ? match[1] : null;
}

/** @returns {Array<{ path: string, language: string|null, content: string }>} files by path (a later complete block replaces an earlier one) */
export function extractCodeFiles(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const files = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const open = FENCE.exec(lines[index]);
    if (!open) continue;
    const fence = open[1];
    const info = open[2].trim();
    const body = [];
    let end = index + 1;
    while (end < lines.length && !(lines[end].trim().startsWith(fence) && lines[end].trim().replace(/^[`~]+/, '') === '')) {
      body.push(lines[end]);
      end += 1;
    }
    let label = null;
    for (let back = index - 1; back >= Math.max(0, index - 2); back -= 1) {
      if (lines[back].trim()) {
        label = pathFromLabel(lines[back]);
        break;
      }
    }
    let path = pathFromInfo(info) ?? label;
    let content = body;
    const commented = body.length ? pathFromComment(body[0]) : null;
    if (!path && commented) path = commented;
    if (path && commented === path) content = body.slice(1);
    if (path && content.some((line) => line.trim()) && !(files.has(path) && isExcerpt(content))) {
      const language = info.split(/\s+/)[0] || null;
      files.set(path, { path, language: isPath(language) ? null : language, content: `${content.join('\n').replace(/\s+$/, '')}\n` });
    }
    index = end;
  }
  return [...files.values()];
}

const slug = (text) =>
  String(text ?? '')
    .replace(/^@[^/]+\//, '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 40);

/** A ZIP with every file under one folder: the package.json name when the answer has one, otherwise "stash-code". */
export function zipFiles(files) {
  let root = 'stash-code';
  const manifest = files.find((file) => file.path === 'package.json');
  if (manifest) {
    try {
      root = slug(JSON.parse(manifest.content).name) || root;
    } catch {
      // not valid JSON: keep the default name
    }
  }
  const zip = new AdmZip();
  for (const file of files) zip.addFile(`${root}/${file.path}`, Buffer.from(file.content, 'utf8'));
  return { buffer: zip.toBuffer(), fileName: `${root}.zip` };
}
