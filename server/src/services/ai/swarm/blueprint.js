/**
 * The architect's blueprint: the whole project planned as strict JSON before any code is written.
 * The micro-agents each write one file from it and see nothing else, so it must make every file
 * buildable on its own and consistent with every other: the file tree, the packages, the shared
 * contracts, and for each file its exports, its imports and an exhaustive spec.
 *
 * validateBlueprint() checks what can be checked before any code exists (paths the ZIP accepts,
 * packages, every planned import pointing at a planned file or a declared package); its errors go
 * back to the architect once. The package.json files are written by the server from the blueprint,
 * so they are always valid JSON and always list what the plan uses.
 */
import { builtinModules } from 'node:module';
import path from 'node:path';
import { isPath } from '../../chat/codeBundles.js';

const posix = path.posix;
export const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|mp3|wav|ogg|flac|m4a|aac|mp4|webm|mov|avi|glb|gltf|fbx|obj|stl|blend|ttf|otf|woff2?|eot|zip|gz|tar|7z|rar|pdf|exe|dll|so|dylib|wasm|bin|db|sqlite)$/i;
const RESOLVE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.css', '.scss', '.vue', '.svelte'];
const PACKAGE_NAME = /^(@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i;
const BUILTINS = new Set(builtinModules.map((name) => name.split('/')[0]));
const LANGUAGES = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.json': 'json', '.css': 'css',
  '.scss': 'scss', '.html': 'html', '.htm': 'html', '.md': 'markdown', '.yml': 'yaml', '.yaml': 'yaml', '.sql': 'sql', '.sh': 'bash', '.glsl': 'glsl',
  '.vert': 'glsl', '.frag': 'glsl', '.prisma': 'prisma', '.svg': 'svg', '.xml': 'xml', '.toml': 'toml', '.txt': 'text', '.env': 'dotenv', '.example': 'dotenv',
};

export const extOf = (file) => posix.extname(file).toLowerCase();
export const languageOf = (file) => LANGUAGES[extOf(file)] ?? (posix.basename(file) === 'Dockerfile' ? 'dockerfile' : 'text');
export const isLocal = (specifier) => specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');

/** The architect's instructions (the chat's own system prompt comes before them). */
export function architectRules({ maxFiles }) {
  return `You are the Master Architect of an AI engineering swarm. You write NO implementation code: you produce the blueprint that parallel agents build the project from. Each agent writes exactly one file and sees only this blueprint, so it must make every file buildable on its own and consistent with every other file.

Return ONE JSON object and nothing else, in this shape:
{
  "name": "kebab-case-project-name",
  "title": "the project's name, in the user's language",
  "summary": "what it is and does, 2-4 sentences, in the user's language",
  "stack": ["each technology with its major version, e.g. React 19"],
  "architecture": "how the parts fit and talk to each other: modules, data flow, state, rendering or game loop",
  "contracts": "the shared contracts, exhaustively: every API endpoint (method, path, request JSON, response JSON, status codes, errors), every data model with field types, events and messages, environment variables with defaults, shared constants, CSS design tokens and every class name used by more than one file",
  "packages": [{ "path": "package.json", "name": "...", "type": "module", "scripts": { "dev": "..." }, "dependencies": { "react": "^19.1.0" }, "devDependencies": {} }],
  "files": [{
    "path": "src/components/Board.jsx",
    "language": "jsx",
    "purpose": "one line",
    "exports": [{ "name": "Board", "kind": "component", "signature": "Board({ cells: Cell[], onPlay: (index: number) => void })" }],
    "imports": [{ "from": "./Cell.jsx", "names": ["Cell"] }, { "from": "react", "names": ["useMemo"] }],
    "spec": "the complete technical spec of this file"
  }],
  "run": "the commands to install and run it"
}

Rules:
- The file tree is complete: every file needed to install, build and run (entry HTML, vite.config.js and other config, styles, client, server, README.md). Don't put package.json in "files": describe each one in "packages" (the server writes them; use npm workspaces for several).
- Text files only: no images, fonts, audio or 3D models. Generate textures procedurally (Canvas, shaders), sounds with Web Audio, icons as inline SVG.
- Imports: relative paths with the exact file name and extension ("./utils/math.js") that resolve to files in the tree; no path aliases such as "@/"; no URLs; packages only from the dependencies of a package.json above the file (or its workspace root); Node built-ins as "node:fs".
- "imports" lists every import of the file and "exports" every export, with the names exactly as in the code ("default" for a default export). When one file uses another's export, the names and signatures match on both sides.
- Size: each file must fit in one agent's answer of about 8,000 tokens (about 600 lines). Split bigger modules.
- "spec" is exhaustive, because it's all the agent knows about the file besides the contracts: every function, component, route or class with its parameters, return value, behavior, edge cases and errors; state and data flow; UI layout, texts and styling; algorithms and constants. Leave no decision to the agent.
- File and folder names: letters, digits and - _ . @ + only, with an extension (Dockerfile, .gitignore and .env.example are fine).
- At most ${maxFiles} files. Use current stable versions and a conventional structure.
- Texts inside the app are in the language the user wrote in, unless they asked otherwise.`;
}

/** The first JSON object in a model's answer. */
export function parseBlueprint(text) {
  const source = String(text ?? '').trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end <= start) return { data: null, error: 'The answer has no JSON object (it may have been cut off).' };
  try {
    return { data: JSON.parse(source.slice(start, end + 1)) };
  } catch (error) {
    return { data: null, error: `The JSON doesn't parse (${error.message}); it may have been cut off.` };
  }
}

export function packageOf(specifier) {
  if (specifier.startsWith('node:')) return { name: specifier, builtin: true };
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return { name, builtin: !specifier.startsWith('@') && BUILTINS.has(name) };
}

/** Folders a leading "/" in an import is resolved from: where each package.json or HTML entry is (Vite's root). */
export function rootsOf(blueprint, paths = blueprint.files.map((file) => file.path)) {
  const roots = new Set(['']);
  for (const file of [...blueprint.packages.map((pkg) => pkg.path), ...paths]) {
    if (file.endsWith('package.json') || /\.html?$/.test(file)) roots.add(posix.dirname(file) === '.' ? '' : posix.dirname(file));
  }
  return [...roots];
}

/** The project file a local import points at, or null. `paths` is a Set of the project's paths. */
export function resolveImport(importer, specifier, paths, roots = ['']) {
  const clean = specifier.replace(/[?#].*$/, '');
  let base;
  if (clean.startsWith('./') || clean.startsWith('../')) base = posix.join(posix.dirname(importer), clean);
  else if (clean.startsWith('/')) {
    const root = roots.filter((item) => item === '' || importer.startsWith(`${item}/`)).sort((a, b) => b.length - a.length)[0] ?? '';
    base = posix.join(root, clean.slice(1));
  } else return null;
  base = posix.normalize(base);
  if (base === '..' || base.startsWith('../')) return null;
  const candidates = [base, ...RESOLVE_EXTENSIONS.map((ext) => base + ext), ...RESOLVE_EXTENSIONS.map((ext) => `${base}/index${ext}`)];
  // TypeScript projects import "./x.js" for x.ts.
  if (/\.[cm]?jsx?$/.test(base)) candidates.push(...['.ts', '.tsx', '.mts', '.cts'].map((ext) => base.replace(/\.[cm]?jsx?$/, ext)));
  return candidates.find((candidate) => paths.has(candidate)) ?? null;
}

/** The package.json files above a file, nearest first. */
export function manifestsAbove(file, packages) {
  return packages
    .filter((pkg) => {
      const dir = posix.dirname(pkg.path);
      return dir === '.' || file.startsWith(`${dir}/`);
    })
    .sort((a, b) => b.path.length - a.path.length);
}

/** Whether a file may import a package: its package.json or one above it (hoisted) lists it, or it's a workspace package. */
export function declares(file, name, packages) {
  if (packages.some((pkg) => pkg.name === name)) return true;
  return manifestsAbove(file, packages).some((pkg) => name in pkg.dependencies || name in pkg.devDependencies);
}

const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const slug = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 80);
const stringMap = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([key, item]) => key && typeof item === 'string')) : {};

function normalizePath(value) {
  if (typeof value !== 'string' || !value.trim()) return { error: 'a path is required' };
  if (value.includes('\\')) return { error: 'use forward slashes' };
  const file = posix.normalize(value.trim().replace(/^\.\//, ''));
  if (file.startsWith('/') || file === '.' || file === '..' || file.startsWith('../')) return { error: 'must be a relative path inside the project' };
  if (BINARY.test(file)) return { error: "binary files can't be generated: make it in code (procedural textures, Web Audio, inline SVG)" };
  if (!isPath(file)) return { error: 'use letters, digits and - _ . @ + in folder and file names, and give the file an extension' };
  return { path: file };
}

function dependencies(value, where, errors) {
  const out = {};
  for (const [name, version] of Object.entries(stringMap(value))) {
    if (!PACKAGE_NAME.test(name)) errors.push(`${where}: "${name}" isn't a valid package name.`);
    else if (!version.trim() || version.length > 100) errors.push(`${where}: "${name}" needs a version.`);
    else out[name] = version.trim();
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

const exportsOf = (value) =>
  (Array.isArray(value) ? value : [])
    .map((item) => (typeof item === 'string' ? { name: item } : item))
    .filter((item) => item && typeof item.name === 'string' && item.name.trim())
    .map((item) => ({ name: item.name.trim(), kind: clip(item.kind, 40) || null, signature: clip(item.signature, 400) || null }));

const importsOf = (value) =>
  (Array.isArray(value) ? value : [])
    .map((item) => (typeof item === 'string' ? { from: item } : item))
    .filter((item) => item && typeof item.from === 'string' && item.from.trim())
    .map((item) => ({ from: item.from.trim(), names: (Array.isArray(item.names) ? item.names : []).filter((name) => typeof name === 'string').map((name) => name.trim()) }));

/**
 * The blueprint, normalized, or the problems that keep it from being built.
 * @returns {{ blueprint: object|null, errors: string[] }}
 */
export function validateBlueprint(raw, { maxFiles = 60 } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { blueprint: null, errors: ['The blueprint must be one JSON object.'] };
  const errors = [];
  const name = slug(raw.name) || 'project';
  const blueprint = {
    name,
    title: clip(raw.title, 120) || clip(raw.name, 80) || 'Project',
    summary: clip(raw.summary, 2_000),
    stack: (Array.isArray(raw.stack) ? raw.stack : []).filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim().slice(0, 60)).slice(0, 20),
    architecture: clip(raw.architecture, 20_000),
    contracts: clip(raw.contracts, 60_000),
    run: clip(raw.run, 4_000),
    packages: [],
    files: [],
  };
  if (!blueprint.summary) errors.push('"summary" is missing.');

  const packages = Array.isArray(raw.packages) ? raw.packages : raw.packages && typeof raw.packages === 'object' ? [raw.packages] : [];
  for (const [index, item] of packages.entries()) {
    const where = `packages[${index}]`;
    const file = normalizePath(item?.path ?? 'package.json');
    if (!item || typeof item !== 'object' || file.error || posix.basename(file.path) !== 'package.json') {
      errors.push(`${where}: "path" must be a relative path ending in package.json.`);
      continue;
    }
    if (blueprint.packages.some((pkg) => pkg.path === file.path)) {
      errors.push(`${where}: ${file.path} is listed twice.`);
      continue;
    }
    const folder = posix.dirname(file.path);
    blueprint.packages.push({
      path: file.path,
      name: PACKAGE_NAME.test(clip(item.name, 214)) ? clip(item.name, 214).toLowerCase() : folder === '.' ? name : slug(posix.basename(folder)) || name,
      private: item.private !== false,
      type: item.type === 'commonjs' || item.type === 'module' ? item.type : undefined,
      workspaces: (Array.isArray(item.workspaces) ? item.workspaces : []).filter((entry) => typeof entry === 'string'),
      scripts: stringMap(item.scripts),
      dependencies: dependencies(item.dependencies, `${where}.dependencies`, errors),
      devDependencies: dependencies(item.devDependencies, `${where}.devDependencies`, errors),
      engines: stringMap(item.engines),
    });
  }

  const files = Array.isArray(raw.files) ? raw.files : [];
  if (!files.length) errors.push('"files" must list every file of the project.');
  const seen = new Set();
  for (const [index, item] of files.entries()) {
    const file = normalizePath(item?.path);
    if (!item || typeof item !== 'object' || file.error) {
      errors.push(`files[${index}] ${JSON.stringify(item?.path ?? null)}: ${file.error ?? 'must be an object'}.`);
      continue;
    }
    if (posix.basename(file.path) === 'package.json') {
      errors.push(`${file.path}: describe package.json files in "packages", not in "files".`);
      continue;
    }
    if (seen.has(file.path.toLowerCase())) {
      errors.push(`${file.path} is listed twice.`);
      continue;
    }
    seen.add(file.path.toLowerCase());
    const spec = clip(item.spec, 40_000);
    if (spec.length < (CODE_EXTENSIONS.has(extOf(file.path)) ? 80 : 20)) errors.push(`${file.path}: the spec is too short to build from; describe everything the file must contain.`);
    blueprint.files.push({ path: file.path, language: clip(item.language, 30) || languageOf(file.path), purpose: clip(item.purpose, 300), exports: exportsOf(item.exports), imports: importsOf(item.imports), spec });
  }
  if (files.length > maxFiles) errors.push(`The plan has ${files.length} files and the limit is ${maxFiles}: merge small files or drop what isn't essential.`);

  const paths = new Set(blueprint.files.map((file) => file.path));
  const roots = rootsOf(blueprint);
  for (const file of blueprint.files) {
    for (const item of file.imports) {
      if (item.from.startsWith('@/') || item.from.startsWith('~/')) errors.push(`${file.path} imports "${item.from}": use a relative path, not an alias.`);
      else if (isLocal(item.from)) {
        if (!resolveImport(file.path, item.from, paths, roots)) errors.push(`${file.path} imports "${item.from}", which isn't in the file tree.`);
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(item.from) && !item.from.startsWith('node:') && !item.from.startsWith('virtual:')) {
        errors.push(`${file.path} imports "${item.from}": use a package from the dependencies, not a URL.`);
      } else if (!item.from.startsWith('virtual:')) {
        const pkg = packageOf(item.from);
        if (!pkg.builtin && !declares(file.path, pkg.name, blueprint.packages)) errors.push(`${file.path} imports the package "${pkg.name}", which no package.json above it lists.`);
      }
    }
  }
  return errors.length ? { blueprint: null, errors: errors.slice(0, 40) } : { blueprint, errors: [] };
}

/** The package.json files, written from the blueprint. */
export function manifestFiles(blueprint) {
  return blueprint.packages.map((pkg) => {
    const json = { name: pkg.name, version: '1.0.0' };
    if (pkg.private) json.private = true;
    if (pkg.type) json.type = pkg.type;
    if (pkg.workspaces.length) json.workspaces = pkg.workspaces;
    if (Object.keys(pkg.scripts).length) json.scripts = pkg.scripts;
    if (Object.keys(pkg.dependencies).length) json.dependencies = pkg.dependencies;
    if (Object.keys(pkg.devDependencies).length) json.devDependencies = pkg.devDependencies;
    if (Object.keys(pkg.engines).length) json.engines = pkg.engines;
    return { path: pkg.path, content: `${JSON.stringify(json, null, 2)}\n` };
  });
}
