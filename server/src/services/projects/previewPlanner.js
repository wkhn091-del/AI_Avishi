/**
 * Decides how a project can be previewed:
 *
 *   site    a ready static site: a build folder (dist, build, out, …) or a
 *           plain index.html whose scripts and styles are all in the archive
 *   readme  no runnable site; the preview shows why, how to run the project
 *           locally, and its README
 *   none    the same without a README
 *
 * An index.html that loads source files (/src/main.tsx) or is a template
 * (%PUBLIC_URL%) needs a build step, and an empty one (just a <title>) has
 * nothing to show, so neither counts as a site.
 */
import * as cheerio from 'cheerio';
import { isolate } from '../../lib/bidi.js';
import { HIDDEN_DIRECTORIES, decodeText, readBytes } from './archiveReader.js';

const SITE_DIRS = ['dist', 'build', 'out', 'www', '_site', 'public', 'site', 'docs', 'html', 'web'];
const SOURCE_REFERENCE = /\.(tsx|jsx|ts|mts|vue|svelte|scss|sass|less)$/i;
const TEMPLATE_MARKERS = /%PUBLIC_URL%|%BASE_URL%|\{\{[^}]*\}\}|\{%|<%[=-]?|@vite\/client/;
const MAX_CANDIDATES = 12;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

/** Cached per opened archive. */
export function previewPlanOf(archive, project) {
  archive.memo.previewPlan ??= planPreview(archive, project);
  return archive.memo.previewPlan;
}

export function planPreview(archive, project) {
  let needsBuild = null;
  for (const candidate of findSiteCandidates(archive)) {
    const verdict = checkSite(archive, candidate);
    if (verdict.ready) return { mode: 'site', webRoot: candidate.dir, entry: candidate.entry };
    if (verdict.why === 'source' && !needsBuild) needsBuild = verdict.reference;
  }
  const readme = findReadme(archive);
  return { mode: readme ? 'readme' : 'none', readme, ...describe(project, needsBuild), hints: runHints(archive, project) };
}

function findSiteCandidates(archive) {
  const found = [];
  for (const filePath of archive.files.keys()) {
    const parts = filePath.split('/');
    const name = parts.at(-1).toLowerCase();
    if (name !== 'index.html' && name !== 'index.htm') continue;
    const folders = parts.slice(0, -1);
    if (folders.length > 4 || folders.some((folder) => HIDDEN_DIRECTORIES.has(folder.toLowerCase()))) continue;
    const rank = SITE_DIRS.indexOf(folders.at(-1)?.toLowerCase());
    const score = !folders.length ? 60 : rank !== -1 ? 100 - rank * 4 - folders.length * 2 : 30 - folders.length * 3;
    found.push({ dir: folders.length ? `${folders.join('/')}/` : '', entry: filePath, score });
  }
  return found.sort((a, b) => b.score - a.score || a.entry.length - b.entry.length).slice(0, MAX_CANDIDATES);
}

function checkSite(archive, { dir, entry }) {
  if (archive.files.get(entry).size > MAX_HTML_BYTES) return { ready: false, why: 'large' };
  const html = decodeText(readBytes(archive, entry)) ?? '';
  if (TEMPLATE_MARKERS.test(html)) return { ready: false, why: 'template' };

  const $ = cheerio.load(html);
  const references = [];
  $('script[src]').each((_, element) => references.push($(element).attr('src')));
  $('link[href]').each((_, element) => {
    if (/stylesheet|modulepreload/i.test($(element).attr('rel') ?? '')) references.push($(element).attr('href'));
  });
  $('script:not([src])').each((_, element) => {
    const imported = /from\s+['"]([^'"]+\.(?:tsx|jsx|ts|vue|svelte))['"]/.exec($(element).html() ?? '');
    if (imported) references.push(imported[1]);
  });

  // A page with nothing to load and nothing to show (just a <title>) would preview as a blank page.
  const hasContent = $('body').text().trim().length >= 20 || $('img, svg, canvas, video, iframe, main, section, article').length > 0;
  if (!references.length && !hasContent) return { ready: false, why: 'empty' };

  let missing = 0;
  for (const reference of references) {
    const local = localPath(reference, dir, entry);
    if (local === null) continue; // CDN or data: URL
    if (SOURCE_REFERENCE.test(local)) return { ready: false, why: 'source', reference: local };
    if (!archive.files.has(local)) missing += 1;
  }
  return missing ? { ready: false, why: 'missing' } : { ready: true };
}

/** Archive path for a URL in index.html; root-absolute URLs resolve against the site root. Null for external URLs. */
function localPath(reference, siteRoot, entry) {
  if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) return null;
  const clean = reference.split(/[?#]/)[0];
  const base = clean.startsWith('/') ? siteRoot : entry.slice(0, entry.lastIndexOf('/') + 1);
  const segments = [];
  for (const part of `${base}${clean.replace(/^\/+/, '')}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(safeDecode(part));
  }
  return segments.join('/');
}

function safeDecode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function findReadme(archive) {
  const readmes = [...archive.files.keys()].filter((p) => /^(docs\/)?readme(\.(md|markdown|mdx|txt|rst))?$/i.test(p));
  const rank = (p) => (p.includes('/') ? 10 : 0) + (/\.(md|markdown|mdx)$/i.test(p) ? 0 : 1);
  return readmes.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** Hebrew title and explanation of why there is no live site. */
function describe(project, needsBuild) {
  const stack = new Set(project.techStack ?? []);
  const has = (label) => stack.has(label);
  if (has('Next.js')) {
    return {
      title: 'אפליקציית Next.js צריכה שרת',
      reason: 'אפליקציית Next.js רצה על שרת Node, ובארכיון אין ייצוא סטטי (תיקיית out), ולכן אי אפשר להציג אותה כאן.',
    };
  }
  if (needsBuild) {
    return {
      title: 'צריך לבנות את האתר כדי לראות אותו',
      reason: `קובץ ה-index.html טוען קוד מקור (${isolate(needsBuild)}) שהדפדפן לא מריץ ישירות. הריצו את הפרויקט מקומית, או בנו אותו והעלו את הארכיון מחדש יחד עם תיקיית ה-build.`,
    };
  }
  const engine = [...stack].find((label) => label.startsWith('Unity') || label.startsWith('Godot'));
  const byKind = {
    web: ['לא נמצא אתר מוכן', 'לא נמצא בארכיון קובץ index.html שאפשר להציג. אם זה אתר, בנו אותו והעלו את הארכיון מחדש יחד עם תיקיית ה-build (למשל dist).'],
    api: ['שירות צד שרת רץ מחוץ לדפדפן', 'זה שירות צד שרת: מריצים אותו בטרמינל, ולכן אין לו תצוגה בדפדפן.'],
    cli: ['כלי שורת פקודה רץ בטרמינל', 'זה כלי שמריצים בטרמינל, ולכן אין לו תצוגה בדפדפן.'],
    bot: ['בוט רץ ברקע', 'זה בוט שרץ כתהליך ברקע ומתחבר לפלטפורמת הצ׳אט, ולכן אין לו תצוגה בדפדפן.'],
    ml: ['פרויקט למידת מכונה רץ ב-Python', 'זה פרויקט למידת מכונה: מריצים אותו עם Python או במחברות, ולכן אין לו תצוגה בדפדפן.'],
    game: engine
      ? [`משחק ${engine.split(' ')[0]} צריך את המנוע`, `כדי להריץ את המשחק צריך את ${engine.split(' ')[0]}. ייצוא ל-Web, שמעלים יחד עם הארכיון, יאפשר לראות אותו כאן.`]
      : ['המשחק צריך סביבת הרצה', 'לא נמצאה בארכיון גרסה של המשחק שרצה בדפדפן.'],
    mobile: ['אפליקציה לנייד', 'מריצים אותה באמולטור או במכשיר, ולכן אין לה תצוגה בדפדפן.'],
    desktop: ['אפליקציית דסקטופ', 'מריצים אותה כתוכנה במחשב, ולכן אין לה תצוגה בדפדפן.'],
    extension: ['תוסף לדפדפן', 'טוענים אותו בדפדפן כתוסף לא ארוז, ולכן אין לו תצוגה כאן.'],
    library: ['ספרייה', 'משתמשים בה מתוך פרויקטים אחרים, ולכן אין לה תצוגה משלה.'],
  };
  const [title, reason] = byKind[project.kind] ?? [
    'אין תצוגה חיה לפרויקט הזה',
    'לא נמצא בארכיון אתר מוכן להצגה: קובץ index.html יחד עם כל הקבצים שהוא טוען.',
  ];
  return { title, reason };
}

/** How to run the project locally: Hebrew label + command (null for GUI steps). */
export function runHints(archive, project) {
  const files = archive.files;
  const has = (p) => files.has(p);
  const visible = (p) => !p.split('/').slice(0, -1).some((folder) => HIDDEN_DIRECTORIES.has(folder.toLowerCase()));
  const shallowest = (test) => [...files.keys()].filter((p) => visible(p) && test(p)).sort((a, b) => a.split('/').length - b.split('/').length)[0];
  const readJson = (p) => {
    try {
      return JSON.parse(decodeText(readBytes(archive, p)) ?? '');
    } catch {
      return null;
    }
  };
  const hints = [];
  const stack = new Set(project.techStack ?? []);

  const packagePath = shallowest((p) => p === 'package.json' || p.endsWith('/package.json'));
  if (packagePath && packagePath.split('/').length <= 2) {
    const dir = packagePath.slice(0, -'package.json'.length);
    const scripts = readJson(packagePath)?.scripts ?? {};
    const pm = has(`${dir}pnpm-lock.yaml`) ? 'pnpm' : has(`${dir}yarn.lock`) ? 'yarn' : has(`${dir}bun.lockb`) || has(`${dir}bun.lock`) ? 'bun' : 'npm';
    const run = (script) => (pm === 'yarn' ? `yarn ${script}` : `${pm} run ${script}`);
    if (dir) hints.push({ label: 'מעבר לתיקייה', command: `cd ${dir.replace(/\/$/, '')}` });
    hints.push({ label: 'התקנת התלויות', command: `${pm} install` });
    if (scripts.tauri) hints.push({ label: 'הרצה', command: run('tauri dev') });
    else if (scripts.dev) hints.push({ label: 'הרצה בסביבת פיתוח', command: run('dev') });
    else if (scripts.start) hints.push({ label: 'הרצה', command: pm === 'yarn' ? 'yarn start' : `${pm} start` });
    if (scripts.build && ['web', 'code'].includes(project.kind)) hints.push({ label: 'בנייה לתצוגה חיה', command: run('build') });
  }

  const requirements = shallowest((p) => /(^|\/)requirements\.txt$/.test(p) && p.split('/').length <= 2);
  if (requirements) hints.push({ label: 'התקנת התלויות', command: `pip install -r ${requirements}` });
  else if (has('pyproject.toml')) hints.push({ label: 'התקנת התלויות', command: 'pip install .' });
  if (requirements || has('pyproject.toml')) {
    if (stack.has('FastAPI') && has('main.py')) hints.push({ label: 'הרצה', command: 'uvicorn main:app --reload' });
    else if (has('manage.py')) hints.push({ label: 'הרצה', command: 'python manage.py runserver' });
    else if (stack.has('Streamlit') && has('app.py')) hints.push({ label: 'הרצה', command: 'streamlit run app.py' });
    else {
      const entry = ['main.py', 'app.py', 'bot.py', 'run.py', 'src/main.py'].find(has);
      if (entry) hints.push({ label: 'הרצה', command: `python ${entry}` });
    }
  }

  if (has('go.mod')) {
    const command = shallowest((p) => /^cmd\/[^/]+\/main\.go$/.test(p));
    hints.push({ label: 'הרצה', command: command ? `go run ./${command.slice(0, -'/main.go'.length)}` : 'go run .' });
  }
  if (has('Cargo.toml')) hints.push({ label: 'הרצה', command: 'cargo run' });
  if (has('pubspec.yaml')) hints.push({ label: 'התקנת התלויות', command: 'flutter pub get' }, { label: 'הרצה', command: 'flutter run' });
  if ([...files.keys()].some((p) => /^[^/]+\.csproj$/i.test(p)) && !has('ProjectSettings/ProjectVersion.txt')) {
    hints.push({ label: 'הרצה', command: 'dotnet run' });
  }
  if (has('composer.json')) hints.push({ label: 'התקנת התלויות', command: 'composer install' });
  if (has('Gemfile')) hints.push({ label: 'התקנת התלויות', command: 'bundle install' });
  if (has('ProjectSettings/ProjectVersion.txt')) hints.push({ label: 'פתיחת התיקייה ב-Unity Hub', command: null });
  if (has('project.godot')) hints.push({ label: 'פתיחת project.godot בעורך Godot', command: null });
  if (has('docker-compose.yml') || has('compose.yaml')) hints.push({ label: 'או עם Docker', command: 'docker compose up' });
  return hints.slice(0, 6);
}
