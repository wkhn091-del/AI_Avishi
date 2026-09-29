/**
 * Pure text → facts parsers for the key files found by the archive scanner.
 * No I/O here, so each function is trivially unit-testable.
 *
 * The parsers are deliberately forgiving: a manifest that fails to parse
 * yields null and the analysis simply falls through to the next signal.
 */
import * as cheerio from 'cheerio';

const clean = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* README                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Scaffolding READMEs describe the template, not the project. When one of
 * these matches, the README is ignored for title/description purposes.
 */
const BOILERPLATE_README = [
  /getting started with create react app/i,
  /bootstrapped with \[?`?create[- ](react|next|vite|expo)/i,
  /this is a \[?next\.js\]?(\([^)]*\))? project bootstrapped/i,
  /welcome to your expo app/i,
  /this template (provides|should help)/i,
  /this project was generated (with|using) \[?angular cli/i,
  /this is a new \[?\*\*react native\*\*\]? project/i,
  /everything you need to build a svelte project/i,
  /^#\s*(react|vue|svelte|preact|lit|solid|vanilla)\s*\+\s*(vite|typescript|ts)\b/im,
];

const GENERIC_HEADINGS = new Set([
  'readme', 'read me', 'getting started', 'installation', 'introduction', 'overview', 'about',
  'table of contents', 'contents', 'documentation', 'docs', 'project', 'project title',
  'my project', 'todo', 'notes', 'setup', 'usage',
]);

/**
 * Removes Markdown/HTML syntax from a line of README text.
 * @param {string} text
 */
export function stripInlineMarkup(text) {
  return String(text)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, ' ') // HTML tags (incl. <img>, <p align=…>)
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ') // images and badges
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1') // [text](url) → text
    .replace(/\[([^\]]+)]\[[^\]]*]/g, '$1') // [text][ref] → text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\*(\S(?:.*?\S)?)\*/g, '$1')
    .replace(/(^|\s)_(\S(?:[^_]*?\S)?)_(?=\s|$|[.,;:!?])/g, '$1$2') // _emphasis_, not snake_case
    .replace(/:[a-z0-9_+-]+:/g, ' ') // :emoji: shortcodes
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function tidyTitle(text) {
  const title = stripInlineMarkup(text)
    .replace(/^[\p{Extended_Pictographic}\uFE0F\s|:–—-]+|[\p{Extended_Pictographic}\uFE0F\s|:–—-]+$/gu, '')
    .trim();
  return title && title.length <= 80 && !GENERIC_HEADINGS.has(title.toLowerCase()) ? title : null;
}

function looksLikeProse(text) {
  return text.length >= 30 && text.split(/\s+/).length >= 5 && /\p{L}{3}/u.test(text) && !/^(table of contents|contents)\b/i.test(text);
}

/** Truncates at a sentence end when possible, otherwise at a word boundary. */
export function truncateText(text, max) {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const sentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (sentenceEnd > max * 0.5) return slice.slice(0, sentenceEnd + 1);
  return `${slice.slice(0, slice.lastIndexOf(' ')).replace(/[,;:\s]+$/, '')}…`;
}

/**
 * @returns {{ title: string|null, summary: string|null, isBoilerplate: boolean, excerpt: string }}
 */
export function parseReadme(text) {
  const source = text.replace(/\r\n?/g, '\n');
  const isBoilerplate = BOILERPLATE_README.some((pattern) => pattern.test(source.slice(0, 4000)));
  const body = source
    .replace(/^---\n[\s\S]*?\n---\n/, '') // YAML front matter
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, ''); // fenced code blocks

  let title = null;
  const lines = body.split('\n');
  for (let i = 0; i < Math.min(lines.length, 120) && !title; i += 1) {
    const line = lines[i].trim();
    const atx = line.match(/^#\s+(.+?)\s*#*$/);
    const html = line.match(/<h1[^>]*>(.*?)<\/h1>/i);
    const setext = line && /^=+$/.test(lines[i + 1]?.trim() ?? '');
    if (atx) title = tidyTitle(atx[1]);
    else if (html) title = tidyTitle(html[1]);
    else if (setext) title = tidyTitle(line);
  }

  let summary = null;
  for (const block of body.split(/\n\s*\n/)) {
    const kept = [];
    const blockLines = block.split('\n');
    for (let i = 0; i < blockLines.length; i += 1) {
      const line = blockLines[i].trim();
      const next = blockLines[i + 1]?.trim() ?? '';
      if (!line || /^#{1,6}\s/.test(line) || /^([-*_]\s*){3,}$/.test(line) || line.startsWith('|')) continue;
      if (/^(=+|-+)$/.test(next) && next.length >= 2) {
        i += 1; // setext heading + underline
        continue;
      }
      if (/^([-*+]|\d+[.)])\s+/.test(line)) break; // lists aren't summaries
      kept.push(line.replace(/^>\s?/, ''));
    }
    const candidate = stripInlineMarkup(kept.join(' '));
    if (looksLikeProse(candidate)) {
      summary = truncateText(candidate, 320);
      break;
    }
  }

  return { title, summary, isBoilerplate, excerpt: source.trim().slice(0, 2000) };
}

/* -------------------------------------------------------------------------- */
/* JavaScript ecosystem                                                        */
/* -------------------------------------------------------------------------- */

export function parsePackageJson(text) {
  const pkg = parseJson(text);
  if (!pkg) return null;
  const dependencyGroups = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies];
  return {
    name: clean(pkg.name),
    productName: clean(pkg.productName) ?? clean(pkg.build?.productName),
    description: clean(pkg.description),
    dependencies: [...new Set(dependencyGroups.flatMap((group) => (group && typeof group === 'object' ? Object.keys(group) : [])))],
    main: clean(pkg.main),
    hasBin: Boolean(pkg.bin),
    isLibrary: Boolean(pkg.exports || pkg.module || pkg.types) && pkg.private !== true,
  };
}

/** Parses index.html: page title and meta description. */
export function parseHtml(text) {
  const $ = cheerio.load(text.slice(0, 200_000));
  return {
    title: clean($('title').first().text()),
    description:
      clean($('meta[name="description"]').attr('content')) ?? clean($('meta[property="og:description"]').attr('content')),
  };
}

/** Browser extension manifest (manifest_version present) — PWA manifests are ignored. */
export function parseExtensionManifest(text) {
  const manifest = parseJson(text);
  if (!manifest?.manifest_version) return null;
  const readable = (value) => (clean(value)?.startsWith('__MSG_') ? null : clean(value));
  return { name: readable(manifest.name), description: readable(manifest.description) };
}

/** Expo app.json → { name } */
export function parseAppJson(text) {
  const app = parseJson(text);
  return app ? { name: clean(app.expo?.name) ?? clean(app.name) } : null;
}

/* -------------------------------------------------------------------------- */
/* Other ecosystems                                                            */
/* -------------------------------------------------------------------------- */

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Raw text of a TOML table (`[name]`) up to the next table header. */
function tomlTable(text, name) {
  const pattern = new RegExp(`^\\[${escapeRegExp(name)}\\][^\\S\\n]*\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm');
  return text.replace(/\r\n?/g, '\n').match(pattern)?.[1] ?? '';
}

function tomlString(table, key) {
  const match = table.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`, 'm'));
  return clean(match?.[1] ?? match?.[2]);
}

function tomlStringArray(table, key) {
  const body = table.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm'))?.[1] ?? '';
  return [...body.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

const tomlKeys = (table) => [...table.matchAll(/^([A-Za-z0-9_.-]+)\s*=/gm)].map((m) => m[1]);
const packageNameOf = (spec) => spec.trim().match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0]?.toLowerCase() ?? null;

export function parsePyproject(text) {
  const project = tomlTable(text, 'project');
  const poetry = tomlTable(text, 'tool.poetry');
  return {
    name: tomlString(project, 'name') ?? tomlString(poetry, 'name'),
    description: tomlString(project, 'description') ?? tomlString(poetry, 'description'),
    dependencies: [
      ...tomlStringArray(project, 'dependencies').map(packageNameOf),
      ...tomlKeys(tomlTable(text, 'tool.poetry.dependencies')).map((key) => key.toLowerCase()),
    ].filter(Boolean),
  };
}

export function parseRequirements(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line && !line.startsWith('-'))
    .map(packageNameOf)
    .filter(Boolean);
}

export function parseCargoToml(text) {
  const pkg = tomlTable(text, 'package');
  const inlineTables = [...text.matchAll(/^\[dependencies\.([A-Za-z0-9_-]+)\]/gm)].map((m) => m[1]);
  return {
    name: tomlString(pkg, 'name'),
    description: tomlString(pkg, 'description'),
    dependencies: [...tomlKeys(tomlTable(text, 'dependencies')), ...inlineTables],
  };
}

export function parseGoMod(text) {
  const modulePath = text.match(/^module\s+(\S+)/m)?.[1] ?? null;
  const requires = [...text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/\S+)\s+v\d/gim)].map((m) => m[1]);
  return { name: modulePath?.split('/').pop() ?? null, dependencies: requires };
}

export function parsePubspec(text) {
  const scalar = (key) => {
    const value = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
    return value && !/^[>|]/.test(value) ? clean(value.replace(/^["']|["']$/g, '')) : null;
  };
  return { name: scalar('name'), description: scalar('description'), isFlutter: /sdk:\s*flutter/.test(text) };
}

export function parseComposerJson(text) {
  const composer = parseJson(text);
  if (!composer) return null;
  return {
    name: clean(composer.name)?.split('/').pop() ?? null,
    description: clean(composer.description),
    dependencies: Object.keys(composer.require ?? {}),
  };
}

export function parseGodotProject(text) {
  const value = (key) => clean(text.match(new RegExp(`^${escapeRegExp(key)}="((?:[^"\\\\]|\\\\.)*)"`, 'm'))?.[1]);
  return { name: value('config/name'), description: value('config/description') };
}

/** ProjectSettings/ProjectVersion.txt → { version: "2022.3" }. Unity 6 releases (6000.x) use their product name: "6", "6.1". */
export function parseUnityVersion(text) {
  const version = text.match(/m_EditorVersion:\s*(\d+)\.(\d+)/);
  if (!version) return null;
  const [, major, minor] = version;
  if (major === '6000') return { version: minor === '0' ? '6' : `6.${minor}` };
  return { version: `${major}.${minor}` };
}

export function parseCsproj(text) {
  return {
    isWeb: /Sdk="Microsoft\.NET\.Sdk\.(Web|BlazorWebAssembly)"/i.test(text),
    isBlazor: /Blazor/i.test(text),
    isWpf: /<UseWPF>\s*true/i.test(text),
    isWinForms: /<UseWindowsForms>\s*true/i.test(text),
    isMonoGame: /MonoGame\.Framework/i.test(text),
  };
}
