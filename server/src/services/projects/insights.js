/**
 * Insights — step 2 of project analysis.
 *
 * Turns an ArchiveScan into deterministic facts: technology stack, language
 * breakdown, project kind, entry points, a visual "fingerprint", and a
 * heuristic title + description. These work with no AI at all; when an AI
 * provider is configured, the summarizer uses them as grounding context and
 * as the fallback.
 */
import { isolate } from '../../lib/bidi.js';
import * as parse from './manifestParsers.js';

/* -------------------------------------------------------------------------- */
/* Detection tables                                                            */
/* -------------------------------------------------------------------------- */

/** npm package → [label, role]. Table order is display priority. */
const NPM_TECH = [
  ['next', 'Next.js', 'framework'], ['nuxt', 'Nuxt', 'framework'], ['@remix-run/react', 'Remix', 'framework'],
  ['astro', 'Astro', 'framework'], ['@sveltejs/kit', 'SvelteKit', 'framework'], ['@angular/core', 'Angular', 'framework'],
  ['expo', 'Expo', 'framework'], ['react-native', 'React Native', 'framework'], ['electron', 'Electron', 'framework'],
  ['@tauri-apps/api', 'Tauri', 'framework'], ['react', 'React', 'framework'], ['vue', 'Vue', 'framework'],
  ['svelte', 'Svelte', 'framework'], ['solid-js', 'Solid', 'framework'], ['preact', 'Preact', 'framework'],
  ['@nestjs/core', 'NestJS', 'framework'], ['express', 'Express', 'framework'], ['fastify', 'Fastify', 'framework'],
  ['koa', 'Koa', 'framework'], ['hono', 'Hono', 'framework'],
  ['phaser', 'Phaser', 'engine'], ['@babylonjs/core', 'Babylon.js', 'engine'], ['babylonjs', 'Babylon.js', 'engine'],
  ['pixi.js', 'PixiJS', 'engine'], ['three', 'Three.js', 'library'], ['@react-three/fiber', 'React Three Fiber', 'library'],
  ['maplibre-gl', 'MapLibre', 'library'], ['@maplibre/maplibre-react-native', 'MapLibre', 'library'],
  ['mapbox-gl', 'Mapbox', 'library'], ['@rnmapbox/maps', 'Mapbox', 'library'], ['leaflet', 'Leaflet', 'library'],
  ['socket.io', 'Socket.IO', 'library'], ['socket.io-client', 'Socket.IO', 'library'], ['discord.js', 'Discord.js', 'library'],
  ['telegraf', 'Telegram Bot API', 'library'], ['grammy', 'Telegram Bot API', 'library'], ['node-telegram-bot-api', 'Telegram Bot API', 'library'],
  ['@prisma/client', 'Prisma', 'library'], ['mongoose', 'MongoDB', 'library'], ['mongodb', 'MongoDB', 'library'],
  ['firebase', 'Firebase', 'platform'], ['firebase-admin', 'Firebase', 'platform'], ['@supabase/supabase-js', 'Supabase', 'platform'],
  ['tailwindcss', 'Tailwind CSS', 'tool'], ['vite', 'Vite', 'tool'], ['webpack', 'webpack', 'tool'],
];

const PYTHON_TECH = [
  ['django', 'Django', 'framework'], ['flask', 'Flask', 'framework'], ['fastapi', 'FastAPI', 'framework'],
  ['streamlit', 'Streamlit', 'framework'], ['gradio', 'Gradio', 'framework'], ['pygame', 'Pygame', 'engine'],
  ['kivy', 'Kivy', 'framework'], ['pyqt5', 'PyQt', 'framework'], ['pyqt6', 'PyQt', 'framework'], ['pyside6', 'PySide', 'framework'],
  ['torch', 'PyTorch', 'library'], ['tensorflow', 'TensorFlow', 'library'], ['scikit-learn', 'scikit-learn', 'library'],
  ['transformers', 'Transformers', 'library'], ['opencv-python', 'OpenCV', 'library'], ['numpy', 'NumPy', 'library'],
  ['pandas', 'pandas', 'library'], ['selenium', 'Selenium', 'library'], ['scrapy', 'Scrapy', 'framework'],
  ['discord.py', 'discord.py', 'library'], ['python-telegram-bot', 'Telegram Bot API', 'library'], ['aiogram', 'aiogram', 'library'],
];

const RUST_TECH = [
  ['bevy', 'Bevy', 'engine'], ['macroquad', 'Macroquad', 'engine'], ['tauri', 'Tauri', 'framework'],
  ['axum', 'Axum', 'framework'], ['actix-web', 'Actix Web', 'framework'], ['tokio', 'Tokio', 'library'],
];

const GO_TECH = [
  ['github.com/gin-gonic/gin', 'Gin', 'framework'], ['github.com/gofiber/fiber', 'Fiber', 'framework'],
  ['github.com/labstack/echo', 'Echo', 'framework'], ['github.com/hajimehoshi/ebiten', 'Ebitengine', 'engine'],
  ['github.com/spf13/cobra', 'Cobra', 'library'],
];

const ML_LABELS = new Set(['PyTorch', 'TensorFlow', 'scikit-learn', 'Transformers']);
const BOT_LABELS = new Set(['Discord.js', 'discord.py', 'Telegram Bot API', 'aiogram']);
const GAME_LABELS = new Set(['Unity', 'Godot', 'Phaser', 'Babylon.js', 'PixiJS', 'Pygame', 'Bevy', 'Macroquad', 'Ebitengine', 'MonoGame']);
const MOBILE_LABELS = new Set(['React Native', 'Expo', 'Flutter', 'Android', 'iOS']);
const DESKTOP_LABELS = new Set(['Electron', 'Tauri', 'WPF', 'WinForms', 'PyQt', 'PySide', 'Kivy']);
const FRONTEND_LABELS = new Set(['Next.js', 'Nuxt', 'Remix', 'Astro', 'SvelteKit', 'Angular', 'React', 'Vue', 'Svelte', 'Solid', 'Preact', 'Blazor', 'Streamlit', 'Gradio']);
const BACKEND_LABELS = new Set(['NestJS', 'Express', 'Fastify', 'Koa', 'Hono', 'Django', 'Flask', 'FastAPI', 'Axum', 'Actix Web', 'Gin', 'Fiber', 'Echo', 'ASP.NET Core', 'Laravel', 'Symfony']);

const LANGUAGE_BY_EXTENSION = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript',
  ts: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', tsx: 'TypeScript',
  py: 'Python', pyw: 'Python', ipynb: 'Jupyter Notebook',
  rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala', swift: 'Swift',
  m: 'Objective-C', mm: 'Objective-C', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', ino: 'C++',
  cs: 'C#', fs: 'F#', php: 'PHP', rb: 'Ruby', dart: 'Dart', lua: 'Lua', gd: 'GDScript', r: 'R', jl: 'Julia',
  ex: 'Elixir', exs: 'Elixir', hs: 'Haskell', zig: 'Zig', sol: 'Solidity',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'SCSS', less: 'Less',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell', bat: 'Batchfile', cmd: 'Batchfile',
  sql: 'SQL', glsl: 'GLSL', frag: 'GLSL', vert: 'GLSL', wgsl: 'WGSL', hlsl: 'HLSL', shader: 'ShaderLab',
};

/** Non-code categories used by the fingerprint (the client picks neutral tones for these). */
const CATEGORY_BY_EXTENSION = {
  md: 'docs', mdx: 'docs', txt: 'docs', rst: 'docs', pdf: 'docs',
  json: 'data', yaml: 'data', yml: 'data', toml: 'data', xml: 'data', csv: 'data', lock: 'data', ini: 'data', env: 'data',
  png: 'asset', jpg: 'asset', jpeg: 'asset', gif: 'asset', webp: 'asset', svg: 'asset', ico: 'asset', avif: 'asset', bmp: 'asset',
  mp3: 'asset', wav: 'asset', ogg: 'asset', mp4: 'asset', webm: 'asset', ttf: 'asset', otf: 'asset', woff: 'asset', woff2: 'asset',
  glb: 'asset', gltf: 'asset', fbx: 'asset', obj: 'asset', blend: 'asset', psd: 'asset',
};

const GENERIC_NAMES = new Set([
  'app', 'my app', 'my project', 'project', 'new project', 'untitled', 'test', 'demo', 'code', 'src', 'source',
  'frontend', 'backend', 'client', 'server', 'web', 'website', 'site', 'starter', 'template', 'archive', 'download',
  'files', 'document', 'home', 'index', 'hello world', 'vite project', 'react app', 'my react app', 'next app',
  'my next app', 'expo app', 'my expo app', 'vite react', 'vite react ts', 'vite vue', 'vite vue ts', 'vite',
  'react', 'vue', 'svelte app', 'vue app', 'create next app', 'expo', 'title', 'page title',
]);

/** Hebrew noun for each kind, with its grammatical gender for verb agreement in generated descriptions. */
const KIND_NOUNS = {
  web: ['אפליקציית ווב', 'f'], api: ['שירות צד שרת', 'm'], mobile: ['אפליקציה לנייד', 'f'], desktop: ['אפליקציית דסקטופ', 'f'],
  game: ['משחק', 'm'], bot: ['צ׳אט בוט', 'm'], extension: ['תוסף לדפדפן', 'm'], ml: ['פרויקט למידת מכונה', 'm'],
  cli: ['כלי שורת פקודה', 'm'], library: ['ספרייה', 'f'], code: ['פרויקט', 'm'],
};

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * @param {import('./archiveScanner.js').ArchiveScan} scan
 */
export function deriveInsights(scan) {
  const facts = readManifests(scan.keyFiles);
  const techStack = detectTechStack(scan, facts);
  const languages = measureLanguages(scan.files);
  const kind = detectKind(scan, facts, techStack, languages);

  const insights = {
    kind,
    techStack: techStack.map((tech) => tech.label),
    languages,
    fingerprint: buildFingerprint(scan.files),
    entryPoints: findEntryPoints(scan.files, facts),
    keyFiles: listKeyFilePaths(scan.keyFiles),
    readme: facts.readme,
  };

  insights.tags = buildTags(techStack, languages);
  insights.heuristic = {
    title: pickTitle(scan, facts),
    description: pickDescription(facts, { kind, techStack, languages, stats: scan.stats }),
  };
  return insights;
}

/** "weather-app-main" → "Weather App", "@me/fooBar" → "Foo Bar". Returns null for empty/generic names. */
export function humanizeName(raw) {
  if (!raw) return null;
  const words = String(raw)
    .trim()
    .replace(/^@[^/]+\//, '') // npm scope
    .replace(/\.(zip|git)$/i, '')
    .replace(/\s*\(\d+\)$/, '') // "project (2)"
    .replace(/[-_ ](main|master|develop|dev|trunk)$/i, '') // GitHub download suffix
    .replace(/[-_ ]v?\d+(\.\d+){1,3}([-_.]?[a-z0-9]+)?$/i, '') // version suffix
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words || isGeneric(words)) return null;
  return words
    .split(' ')
    .map((word) => (/^[a-z]/.test(word) ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

const normalizeKey = (text) => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const isGeneric = (text) => !normalizeKey(text) || GENERIC_NAMES.has(normalizeKey(text));
const extensionOf = (path) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();
const fileNameOf = (path) => path.slice(path.lastIndexOf('/') + 1);

function readManifests(keyFiles) {
  const one = (file, parser) => (file ? parser(file.text) : null);
  const packages = keyFiles.packageJson.map((file) => ({ path: file.path, ...parse.parsePackageJson(file.text) })).filter((p) => p.name !== undefined);
  return {
    readme: one(keyFiles.readme, parse.parseReadme),
    packages, // shallowest first
    rootPackage: packages[0] ?? null,
    html: one(keyFiles.indexHtml, parse.parseHtml),
    pyproject: one(keyFiles.pyproject, parse.parsePyproject),
    requirements: keyFiles.requirements.flatMap((file) => parse.parseRequirements(file.text)),
    cargo: one(keyFiles.cargoToml, parse.parseCargoToml),
    goMod: one(keyFiles.goMod, parse.parseGoMod),
    pubspec: one(keyFiles.pubspec, parse.parsePubspec),
    composer: one(keyFiles.composerJson, parse.parseComposerJson),
    extension: keyFiles.webManifest.map((file) => parse.parseExtensionManifest(file.text)).find(Boolean) ?? null,
    expo: one(keyFiles.appJson, parse.parseAppJson),
    godot: one(keyFiles.godotProject, parse.parseGodotProject),
    unity: one(keyFiles.unityVersion, parse.parseUnityVersion),
    csproj: keyFiles.csproj ? { ...parse.parseCsproj(keyFiles.csproj.text), name: fileNameOf(keyFiles.csproj.path).replace(/\.csproj$/i, '') } : null,
  };
}

function detectTechStack(scan, facts) {
  const found = new Map(); // label → { label, role, order }
  const add = (label, role, order) => {
    if (!found.has(label)) found.set(label, { label, role, order });
  };
  const fromTable = (table, dependencies, offset) => {
    const deps = new Set(dependencies.map((d) => d.toLowerCase()));
    table.forEach(([pkg, label, role], index) => {
      if (deps.has(pkg) || [...deps].some((d) => d.startsWith(`${pkg}/`))) add(label, role, offset + index);
    });
  };

  // Engines and platforms first — they define what the project *is*.
  if (facts.unity) add(`Unity ${facts.unity.version}`.trim(), 'engine', 0);
  if (facts.godot) add('Godot', 'engine', 1);
  if (facts.pubspec?.isFlutter) add('Flutter', 'framework', 2);
  if (facts.csproj?.isMonoGame) add('MonoGame', 'engine', 3);
  if (facts.csproj?.isBlazor) add('Blazor', 'framework', 4);
  else if (facts.csproj?.isWeb) add('ASP.NET Core', 'framework', 4);
  if (facts.csproj?.isWpf) add('WPF', 'framework', 5);
  if (facts.csproj?.isWinForms) add('WinForms', 'framework', 5);

  fromTable(NPM_TECH, facts.packages.flatMap((p) => p.dependencies ?? []), 100);
  fromTable(PYTHON_TECH, [...facts.requirements, ...(facts.pyproject?.dependencies ?? [])], 200);
  fromTable(RUST_TECH, facts.cargo?.dependencies ?? [], 300);
  fromTable(GO_TECH, facts.goMod?.dependencies ?? [], 400);
  const composerDeps = facts.composer?.dependencies ?? [];
  if (composerDeps.includes('laravel/framework')) add('Laravel', 'framework', 500);
  if (composerDeps.some((d) => d.startsWith('symfony/'))) add('Symfony', 'framework', 501);

  // Signals from file presence.
  const paths = scan.files.map((f) => f.path.toLowerCase());
  const has = (predicate) => paths.some(predicate);
  if (has((p) => p.endsWith('androidmanifest.xml'))) add('Android', 'platform', 600);
  if (has((p) => p.includes('.xcodeproj/'))) add('iOS', 'platform', 601);
  if (has((p) => fileNameOf(p) === 'dockerfile' || /(^|\/)(docker-)?compose\.ya?ml$/.test(p))) add('Docker', 'tool', 700);
  if (has((p) => fileNameOf(p) === 'cmakelists.txt')) add('CMake', 'tool', 701);
  if (facts.csproj && ![...found.values()].some((t) => t.role !== 'tool')) add('.NET', 'framework', 702);

  return [...found.values()].sort((a, b) => a.order - b.order);
}

/** Language share by bytes, like GitHub's linguist. Minified bundles are skipped. */
function measureLanguages(files) {
  const bytes = new Map();
  let total = 0;
  for (const { path, size } of files) {
    const language = LANGUAGE_BY_EXTENSION[extensionOf(path)];
    if (!language || /\.min\.(js|css)$/i.test(path)) continue;
    bytes.set(language, (bytes.get(language) ?? 0) + size);
    total += size;
  }
  if (!total) return [];
  return [...bytes.entries()]
    .map(([name, size]) => ({ name, share: Math.round((size / total) * 1000) / 10 }))
    .filter((language) => language.share >= 0.5)
    .sort((a, b) => b.share - a.share)
    .slice(0, 6);
}

function detectKind(scan, facts, techStack, languages) {
  const labels = new Set(techStack.map((t) => t.label.replace(/^Unity .*/, 'Unity')));
  const any = (set) => [...labels].some((label) => set.has(label));
  const paths = scan.files.map((f) => f.path.toLowerCase());

  if (any(GAME_LABELS) || paths.some((p) => /(^|\/)(main|conf)\.lua$/.test(p))) return 'game';
  if (facts.extension) return 'extension';
  if (any(MOBILE_LABELS)) return 'mobile';
  if (any(DESKTOP_LABELS)) return 'desktop';
  if (any(FRONTEND_LABELS) || facts.html) return 'web';
  // ML and bots before 'api': both often ship a small web server (an inference endpoint, a webhook).
  if (any(ML_LABELS) || languages[0]?.name === 'Jupyter Notebook') return 'ml';
  if (any(BOT_LABELS)) return 'bot';
  if (any(BACKEND_LABELS)) return 'api';
  if (facts.rootPackage?.hasBin || paths.some((p) => /^cmd\/[^/]+\/main\.go$/.test(p))) return 'cli';
  if (facts.rootPackage?.isLibrary || paths.includes('src/lib.rs')) return 'library';
  return 'code';
}

/**
 * A compact visual signature of the codebase: up to 64 bars in path order.
 * Each bar is [category, height 1–10] where category is a language name or
 * docs/data/asset/other, and height is log-scaled bytes. Small projects get
 * one bar per file, so the strip's length itself shows the project's size.
 */
function buildFingerprint(files, maxBars = 64) {
  if (!files.length) return [];
  const barCount = Math.min(maxBars, files.length);
  const slices = [];
  for (let i = 0; i < barCount; i += 1) {
    const start = Math.floor((i * files.length) / barCount);
    const end = Math.max(start + 1, Math.floor(((i + 1) * files.length) / barCount));
    const byCategory = new Map();
    let bytes = 0;
    for (const file of files.slice(start, end)) {
      const ext = extensionOf(file.path);
      const category = LANGUAGE_BY_EXTENSION[ext] ?? CATEGORY_BY_EXTENSION[ext] ?? 'other';
      byCategory.set(category, (byCategory.get(category) ?? 0) + file.size + 1);
      bytes += file.size;
    }
    const category = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0][0];
    slices.push({ category, bytes });
  }
  const maxLog = Math.log1p(Math.max(...slices.map((s) => s.bytes)));
  return slices.map(({ category, bytes }) => [category, maxLog ? Math.max(1, Math.round((Math.log1p(bytes) / maxLog) * 10)) : 1]);
}

const ENTRY_POINT_PATTERNS = [
  /^index\.html$/, /^src\/(main|index)\.(tsx?|jsx?|mjs)$/, /^(main|index)\.(tsx?|jsx?|mjs)$/, /^src\/App\.(tsx|jsx|vue|svelte)$/,
  /^App\.(tsx|jsx|ts|js)$/, /^app\/(_layout|index)\.(tsx|jsx|ts|js)$/, // Expo / expo-router
  /^(src\/)?app\/page\.(tsx|jsx)$/, /^pages\/index\.(tsx|jsx|js)$/, /^(server|app)\.(js|ts|mjs)$/, /^src\/(server|app)\.(js|ts)$/,
  /^(main|app|manage|run|bot)\.py$/, /^src\/main\.rs$/, /^main\.go$/, /^cmd\/[^/]+\/main\.go$/, /^lib\/main\.dart$/,
  /^Program\.cs$/, /^(src\/)?main\.(c|cpp)$/, /^main\.lua$/, /^Assets\/Scenes\/[^/]+\.unity$/,
];

function findEntryPoints(files, facts) {
  const found = [];
  for (const { path } of files) {
    const withoutFirstFolder = path.includes('/') ? path.slice(path.indexOf('/') + 1) : null;
    if (ENTRY_POINT_PATTERNS.some((re) => re.test(path) || (withoutFirstFolder && re.test(withoutFirstFolder)))) found.push(path);
  }
  const main = facts.rootPackage?.main;
  if (main) {
    const folder = facts.rootPackage.path.includes('/') ? facts.rootPackage.path.slice(0, facts.rootPackage.path.lastIndexOf('/') + 1) : '';
    const candidate = `${folder}${main.replace(/^\.\//, '')}`;
    if (files.some((f) => f.path === candidate)) found.unshift(candidate);
  }
  return [...new Set(found)].sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 6);
}

function listKeyFilePaths(keyFiles) {
  return Object.values(keyFiles)
    .flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []))
    .map((file) => file.path)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, 12);
}

function buildTags(techStack, languages) {
  const tags = techStack.filter((t) => t.role !== 'tool').map((t) => t.label);
  for (const language of languages.slice(0, 2)) if (!tags.includes(language.name)) tags.push(language.name);
  for (const tool of techStack.filter((t) => t.role === 'tool')) tags.push(tool.label);
  return [...new Set(tags)].slice(0, 8);
}

/** Title priority: README H1 → app/product names → <title> → package names → archive/folder name. */
function pickTitle(scan, facts) {
  const readme = facts.readme && !facts.readme.isBoilerplate ? facts.readme.title : null;
  const htmlTitle = facts.html?.title?.split(/\s+[|–—-]\s+/)[0];
  const candidates = [
    readme,
    facts.rootPackage?.productName, facts.expo?.name, facts.extension?.name, facts.godot?.name,
    htmlTitle,
    humanizeName(facts.rootPackage?.name), humanizeName(facts.pyproject?.name), humanizeName(facts.cargo?.name),
    humanizeName(facts.pubspec?.name), humanizeName(facts.goMod?.name), humanizeName(facts.composer?.name),
    humanizeName(facts.csproj?.name),
    humanizeName(scan.archiveName), humanizeName(scan.rootFolder),
  ];
  const title = candidates.find((candidate) => candidate && !isGeneric(candidate) && candidate.length <= 80);
  return title ?? 'פרויקט ללא שם';
}

/** Description priority: README paragraph → manifest descriptions → <meta> → generated from the stack. */
function pickDescription(facts, context) {
  const readme = facts.readme && !facts.readme.isBoilerplate ? facts.readme.summary : null;
  const candidates = [
    readme,
    facts.rootPackage?.description, facts.extension?.description, facts.pyproject?.description, facts.cargo?.description,
    facts.pubspec?.description, facts.composer?.description, facts.godot?.description, facts.html?.description,
  ];
  const found = candidates.find((candidate) => candidate && candidate.length >= 12);
  return found ? parse.truncateText(parse.stripInlineMarkup(found), 320) : generateDescription(context);
}

/**
 * Hebrew sentence from the detected facts, e.g.
 * "אפליקציית ווב שנבנתה עם React ו-Vite, ונכתבה בעיקר ב-TypeScript."
 * Technology names are wrapped in Unicode isolates so names like "C#" keep
 * their shape inside the right-to-left sentence.
 */
function generateDescription({ kind, techStack, languages, stats }) {
  if (!stats.fileCount) return 'ארכיון ריק: לא נמצאו בו קובצי פרויקט.';
  const listFormat = new Intl.ListFormat('he', { style: 'long', type: 'conjunction' });
  const builtWith = techStack.filter((t) => t.role !== 'language').slice(0, 3).map((t) => isolate(t.label));
  const language = languages[0]?.name;
  const [noun, gender] = KIND_NOUNS[kind] ?? KIND_NOUNS.code;
  const feminine = gender === 'f';
  let sentence = noun;
  if (builtWith.length) sentence += ` ${feminine ? 'שנבנתה' : 'שנבנה'} עם ${listFormat.format(builtWith)}`;
  if (language) {
    const written = feminine ? 'נכתבה' : 'נכתב';
    sentence += builtWith.length ? `, ו${written} בעיקר ב-${isolate(language)}` : ` ש${written} בעיקר ב-${isolate(language)}`;
  }
  return `${sentence}.`;
}
