/**
 * Syntax highlighting: highlight.js core with a hand-picked set of languages,
 * which keeps the bundle small. The output is escaped HTML.
 */
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dart from 'highlight.js/lib/languages/dart';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = {
  bash, c, cpp, csharp, css, dart, dockerfile, go, ini, java, javascript, json, kotlin, less, lua, makefile, markdown,
  php, plaintext, powershell, python, ruby, rust, scss, sql, swift, typescript, xml, yaml,
};
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);

const BY_EXTENSION = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json', webmanifest: 'json', map: 'json', ipynb: 'json',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml', xaml: 'xml', csproj: 'xml', plist: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less', md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  py: 'python', pyw: 'python', gd: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  cs: 'csharp', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', php: 'php', rb: 'ruby',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', properties: 'ini', godot: 'ini', tscn: 'ini', tres: 'ini',
  sql: 'sql', dart: 'dart', swift: 'swift', lua: 'lua', txt: 'plaintext', log: 'plaintext', csv: 'plaintext',
};
const BY_NAME = { dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile', '.gitignore': 'ini', '.env': 'ini', '.editorconfig': 'ini', '.npmrc': 'ini' };

const LANGUAGE_LABELS = {
  javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON', xml: 'XML', css: 'CSS', scss: 'SCSS', less: 'Less',
  markdown: 'Markdown', python: 'Python', go: 'Go', rust: 'Rust', java: 'Java', kotlin: 'Kotlin', csharp: 'C#', c: 'C',
  cpp: 'C++', php: 'PHP', ruby: 'Ruby', bash: 'Shell', powershell: 'PowerShell', yaml: 'YAML', ini: 'INI', sql: 'SQL',
  dart: 'Dart', swift: 'Swift', lua: 'Lua', dockerfile: 'Dockerfile', makefile: 'Makefile', plaintext: 'טקסט',
};
const LABEL_BY_EXTENSION = { tsx: 'TSX', jsx: 'JSX', vue: 'Vue', svelte: 'Svelte', toml: 'TOML', gd: 'GDScript', svg: 'SVG', html: 'HTML', htm: 'HTML', ipynb: 'Jupyter' };

/** Highlight.js language and a display label for a file path. */
export function languageOf(filePath) {
  const name = filePath.split('/').pop().toLowerCase();
  const extension = name.includes('.') ? name.split('.').pop() : '';
  const language = BY_NAME[name] ?? BY_EXTENSION[extension] ?? null;
  return { language, label: LABEL_BY_EXTENSION[extension] ?? (language ? LANGUAGE_LABELS[language] : null) };
}

const FENCE_ALIASES = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', shell: 'bash',
  console: 'bash', zsh: 'bash', yml: 'yaml', html: 'xml', vue: 'xml', rs: 'rust', cs: 'csharp', 'c#': 'csharp',
  'c++': 'cpp', md: 'markdown', toml: 'ini', ps1: 'powershell', kt: 'kotlin', rb: 'ruby', golang: 'go', docker: 'dockerfile',
};

/** Language named by a Markdown code fence ("ts", "py", "shell"…), when supported. */
export function fenceLanguage(name) {
  const key = String(name ?? '').toLowerCase();
  const language = FENCE_ALIASES[key] ?? key;
  return hljs.getLanguage(language) ? language : null;
}

const MAX_HIGHLIGHT_CHARS = 200_000;
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text) => text.replace(/[&<>"']/g, (char) => ENTITIES[char]);

/** Highlighted HTML (escaped plain text when the language is unknown or the text very long). */
export function highlightToHtml(text, language) {
  if (language && language !== 'plaintext' && text.length <= MAX_HIGHLIGHT_CHARS && hljs.getLanguage(language)) {
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      // fall back to plain text
    }
  }
  return escapeHtml(text);
}
