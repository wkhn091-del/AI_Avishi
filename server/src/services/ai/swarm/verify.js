/**
 * Building and running a generated project in the sandbox (sandbox/): the errors only real tools find.
 * The steps come from the project's package.json files:
 *   install  npm install, with the network; every step after it runs offline
 *   build    npm run build, where there's a build script
 *   types    tsc --noEmit where there's a tsconfig.json and TypeScript (or a typecheck script)
 *   test     npm test, where there's a real test script
 *   start    a server's npm start for a few seconds: it must come up and stay up
 * A failed step becomes issues on the files that must change: the importer or the exporter for a
 * missing export (the blueprint's promise decides, as in checks.js), the importer for an import that
 * doesn't resolve, every file tsc names, the file in a crash's stack trace, and, when a test fails or
 * the log names no file, a model's triage. Some install failures are repaired on the spot: a version
 * that doesn't exist becomes "latest", a peer conflict is retried with --legacy-peer-deps, and a
 * package that doesn't exist is removed (the files that import it go back to be rewritten). After a
 * good install, the packages added as "latest" are pinned to the versions that were installed.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { manifestFiles } from './blueprint.js';

const posix = path.posix;
export const INSTALL = 'npm install --no-audit --no-fund --no-progress --loglevel=error';
export const STEP_LABELS = Object.freeze({ install: 'התקנה', build: 'בנייה', types: 'בדיקת טיפוסים', test: 'בדיקות', start: 'הפעלת השרת' });
export const SERVER_PACKAGES = ['express', 'fastify', 'koa', 'hono', '@hono/node-server', '@nestjs/core', 'ws', 'socket.io', 'restify', '@hapi/hapi', 'polka'];
const dirOf = (file) => (posix.dirname(file) === '.' ? '' : posix.dirname(file));
const deps = (pkg) => ({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) });
const quote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;

function inWorkspaces(dir, patterns = []) {
  return patterns.some((pattern) => {
    const clean = pattern.replace(/^\.\//, '').replace(/\/$/, '');
    const regex = new RegExp(`^${clean.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]+').replace(/\u0000/g, '.+')}$`);
    return regex.test(dir);
  });
}

/** A server's npm start: up for `seconds` and still running counts as a success. */
export const startProbe = (seconds) =>
  `[ -f .env ] || [ ! -f .env.example ] || cp .env.example .env; timeout ${seconds} npm start; code=$?; if [ "$code" = 124 ]; then echo "[stash] still running after ${seconds}s"; exit 0; fi; exit $code`;

/** What to run, in order. */
export function planSteps(blueprint, files, settings) {
  const packages = blueprint.packages.map((pkg) => ({ ...pkg, dir: dirOf(pkg.path) })).sort((a, b) => a.dir.length - b.dir.length);
  if (!packages.length) return [];
  const root = packages.find((pkg) => pkg.dir === '');
  const covered = (pkg) => pkg.dir === '' || Boolean(root && inWorkspaces(pkg.dir, root.workspaces));
  // npm's placeholder test script ("no test specified") is no test.
  const real = (pkg, name) => Boolean(pkg?.scripts[name]) && !(name === 'test' && /no test specified/.test(pkg.scripts[name]));
  // A root script (npm run build --workspaces …) runs the covered packages' own.
  const own = (pkg, name) => real(pkg, name) && (pkg.dir === '' || !real(root, name) || !covered(pkg));
  const step = (id, pkg, command, seconds) => ({ id, dir: pkg.dir, command, seconds, label: STEP_LABELS[id] });
  const steps = [];
  for (const pkg of packages) if (pkg.dir === '' || !covered(pkg)) steps.push(step('install', pkg, INSTALL, settings.stepSeconds));
  for (const pkg of packages) if (own(pkg, 'build')) steps.push(step('build', pkg, 'npm run build', settings.stepSeconds));
  for (const pkg of packages) {
    if (own(pkg, 'typecheck')) steps.push(step('types', pkg, 'npm run typecheck', settings.stepSeconds));
    else if (!pkg.scripts.typecheck && files.has(posix.join(pkg.dir, 'tsconfig.json')) && ('typescript' in deps(pkg) || 'typescript' in deps(root)) && !/\btsc\b/.test(pkg.scripts.build ?? '')) {
      steps.push(step('types', pkg, 'npx --no-install tsc --noEmit --pretty false', settings.stepSeconds));
    }
  }
  for (const pkg of packages) if (own(pkg, 'test')) steps.push(step('test', pkg, 'npm test', settings.stepSeconds));
  for (const pkg of packages) {
    if (pkg.scripts.start && (SERVER_PACKAGES.some((name) => name in deps(pkg)) || /^(node|tsx|ts-node)\s/.test(pkg.scripts.start))) steps.push(step('start', pkg, startProbe(settings.startSeconds), settings.startSeconds + 30));
  }
  return steps;
}

export const cleanLog = (text) => String(text ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
const NOISE = /^\s*at .*(node_modules|node:internal|\(node:|<anonymous>)|^npm error A complete log|^npm (error|ERR!) (code|path|command|errno)\b|^\s*\^+\s*$/;
/** The part of a log that says what went wrong: from the first error line, without library stack frames. */
export function excerpt(log, max = 2_500) {
  const lines = cleanLog(log).split('\n').filter((line) => line.trim() && !NOISE.test(line));
  const start = Math.max(0, lines.findIndex((line) => /error|Error|ERR!|✗|FAIL|not ok|failed|Cannot find/.test(line)));
  const text = lines.slice(start, start + 40).join('\n');
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

const EXT = '(?:jsx?|tsx?|mjs|cjs|mts|cts|vue|svelte|css|scss|json|html)';
const ABSOLUTE = new RegExp(`(?:file://)?((?:/[\\w@.+-]+)+\\.${EXT})(?:[:(](\\d+))?`, 'g');
const RELATIVE = new RegExp(`(?<![\\w@./:-])((?:\\.{1,2}/)?[\\w@.+-]+(?:/[\\w@.+-]+)*\\.${EXT})(?:[:(](\\d+))?`, 'g');

/** The project files a log names, in order, with the first line number given for each. */
export function filesInLog(log, { root, dir = '', paths }) {
  const found = new Map();
  const add = (candidate, line) => {
    if (!candidate || candidate.includes('node_modules/') || !paths.has(candidate) || found.has(candidate)) return;
    found.set(candidate, line ? Number(line) : null);
  };
  const text = cleanLog(log);
  for (const match of text.matchAll(ABSOLUTE)) if (match[1].startsWith(`${root}/`)) add(match[1].slice(root.length + 1), match[2]);
  for (const match of text.matchAll(RELATIVE)) {
    add(posix.normalize(posix.join(dir, match[1])), match[2]);
    add(posix.normalize(match[1]), match[2]);
  }
  return found;
}

/** Issues from the messages that say exactly which file must change. Null when the log has none of them. */
export function blame(log, { root, dir = '', paths, blueprint }) {
  const text = cleanLog(log);
  const toProject = (file) => {
    if (!file) return null;
    const clean = file.replace(/^file:\/\//, '');
    if (clean.startsWith(`${root}/`)) return paths.has(clean.slice(root.length + 1)) ? clean.slice(root.length + 1) : null;
    const inDir = posix.normalize(posix.join(dir, clean));
    return paths.has(inDir) ? inDir : paths.has(posix.normalize(clean)) ? posix.normalize(clean) : null;
  };
  const promises = (file, name) => Boolean(blueprint.files.find((item) => item.path === file)?.exports.some((item) => item.name === name));
  // Vite / Rollup: "x" is not exported by "a", imported by "b".
  const rollup = /"([^"]+)" is not exported by "([^"]+)", imported by "([^"]+)"/.exec(text);
  if (rollup) {
    const [, name, from, by] = rollup;
    const exporter = toProject(from);
    const importer = toProject(by);
    if (exporter && promises(exporter, name)) return [{ path: exporter, message: `Must export "${name}": the blueprint promises it, and ${importer ?? by} imports it.` }];
    if (importer ?? exporter) return [{ path: importer ?? exporter, message: `Imports "${name}" from "${from}", which doesn't export it.` }];
  }
  // Node: The requested module './x.js' does not provide an export named 'y' (the importer is the file:// line above it).
  const node = /The requested module '([^']+)' does not provide an export named '([^']+)'/.exec(text);
  if (node) {
    const url = /file:\/\/(\/[^\s:]+):(\d+)/.exec(text);
    const importer = url ? toProject(url[1]) : null;
    const exporter = importer && node[1].startsWith('.') ? toProject(posix.join(posix.dirname(`${root}/${importer}`), node[1])) : null;
    if (exporter && promises(exporter, node[2])) return [{ path: exporter, message: `Must export "${node[2]}": the blueprint promises it, and ${importer} imports it.` }];
    if (importer) return [{ path: importer, line: Number(url[2]), message: `Imports "${node[2]}" from "${node[1]}", which doesn't export it.` }];
  }
  // Vite / Rollup: Could not resolve "x" from "y".
  const unresolved = /Could not resolve "([^"]+)" from "([^"]+)"/.exec(text);
  if (unresolved && toProject(unresolved[2])) return [{ path: toProject(unresolved[2]), message: `Imports "${unresolved[1]}", which the build can't find.` }];
  // tsc: path(line,col): error TSxxxx: message, for every file it names.
  const typeErrors = new Map();
  for (const match of text.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm)) {
    const file = toProject(match[1].trim());
    if (!file) continue;
    const list = typeErrors.get(file) ?? [];
    if (list.length < 15) list.push({ line: Number(match[2]), text: `line ${match[2]}: ${match[4]} ${match[5]}` });
    typeErrors.set(file, list);
  }
  if (typeErrors.size) return [...typeErrors].map(([file, list]) => ({ path: file, line: list[0].line, message: `TypeScript errors:\n${list.map((item) => item.text).join('\n')}` }));
  return null;
}

/** What an install's log says about packages and versions. */
export function installProblems(log) {
  const text = cleanLog(log);
  const missingVersions = [...text.matchAll(/No matching version found for ((?:@[\w.-]+\/)?[\w.-]+)@(\S+?)\.?(?=\s|$)/g)].map((match) => ({ name: match[1], spec: match[2] }));
  const missingPackages = [
    ...new Set([
      ...[...text.matchAll(/'((?:@[\w.-]+\/)?[\w.-]+)@[^']*' is not in this registry/g)].map((match) => match[1]),
      ...[...text.matchAll(/404 Not Found - GET https?:\/\/\S+?\/((?:@[\w.-]+(?:\/|%2[fF]))?[\w.-]+)(?:\s|$)/g)].map((match) => decodeURIComponent(match[1])),
    ]),
  ];
  return { missingVersions, missingPackages, peerConflict: /\bERESOLVE\b/.test(text) };
}

/** How many tests passed and failed: node:test, Vitest and Jest. */
export function testCounts(log) {
  const text = cleanLog(log);
  const node = /^# pass (\d+)$[\s\S]*?^# fail (\d+)$/m.exec(text) ?? /^ℹ pass (\d+)$[\s\S]*?^ℹ fail (\d+)$/m.exec(text);
  if (node) return { passed: Number(node[1]), failed: Number(node[2]) };
  const vitest = /Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/.exec(text);
  if (vitest) return { passed: Number(vitest[2]), failed: Number(vitest[1] ?? 0) };
  const jest = /Tests:\s+(?:(\d+) failed,\s*)?(?:\d+ skipped,\s*)?(\d+) passed/.exec(text);
  if (jest) return { passed: Number(jest[2]), failed: Number(jest[1] ?? 0) };
  const failedOnly = /Tests\s+(\d+) failed|Tests:\s+(\d+) failed/.exec(text);
  return failedOnly ? { passed: 0, failed: Number(failedOnly[1] ?? failedOnly[2]) } : null;
}

// A server that stops at startup for a reason in its code (not a missing setting) goes back to be fixed.
const CODE_CRASH = /SyntaxError|ReferenceError|TypeError|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|ERR_UNKNOWN_FILE_EXTENSION|Cannot find module|does not provide an export named|is not a function|is not defined|is not a constructor|Unexpected token/;

const PIN = `const fs=require('fs'),path=require('path');const wanted=JSON.parse(process.argv[1]);const out={};for(const [dir,names] of Object.entries(wanted)){out[dir]={};for(const name of names){let d=path.resolve(dir||'.');for(;;){const p=path.join(d,'node_modules',name,'package.json');if(fs.existsSync(p)){try{out[dir][name]=JSON.parse(fs.readFileSync(p,'utf8')).version}catch{}break}const up=path.dirname(d);if(up===d)break;d=up}}}console.log(JSON.stringify(out))`;

// The package.json files as they are in the project (what an install used): an edit's come from its saved
// version, and a blueprint back from the database has its keys reordered, so they're hashed as files.
export const manifestsHash = (blueprint, files = null) =>
  createHash('sha256').update(manifestFiles(blueprint).map((item) => `${item.path}\n${files?.get(item.path) ?? item.content}`).join('\n')).digest('hex');
const importsPackage = (code, name) => new RegExp(`(?:from\\s*|require\\(\\s*|import\\(\\s*)['"]${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?:/[^'"]*)?['"]`).test(code);

/**
 * Runs the steps once. `installedHash` is the manifests' hash at the last good install: an install is
 * run only when they changed. Changes the blueprint's packages when it repairs or pins them.
 * @returns {Promise<{ steps: object[], issues: Map<string, object[]>, unfixable: object[], notes: string[], pinned: string[], removed: string[], reset: string[], installedHash: string|null, ok: boolean, offline: boolean }>}
 */
export async function verifyProject({ box, files, blueprint, settings, installedHash = null, onStep = () => {}, onStepDone = () => {}, triage = null, signal, only = null }) {
  // `only`: some of the steps (a preview brought back only needs its install).
  const steps = planSteps(blueprint, files, settings).filter((step) => !only || only.includes(step.id));
  const result = { steps: [], issues: new Map(), unfixable: [], notes: [], pinned: [], removed: [], reset: [], installedHash, ok: true, offline: false };
  if (!steps.length) return result;
  const paths = new Set(files.keys());
  const add = (file, issue) => {
    const list = result.issues.get(file) ?? [];
    list.push({ source: 'sandbox', ...issue });
    result.issues.set(file, list);
  };
  // Each step's result, as soon as it's known (the live dashboard shows them one by one).
  const push = (entry) => {
    result.steps.push(entry);
    onStepDone(entry);
  };
  const writeManifests = async () => {
    const manifests = new Map(manifestFiles(blueprint).map((item) => [item.path, item.content]));
    for (const [file, content] of manifests) files.set(file, content);
    await box.writeFiles(manifests);
  };
  const exec = async (step, command = step.command) => {
    const started = Date.now();
    const run = await box.run(`(${command}) 2>&1`, { cwd: step.dir, timeoutMs: step.seconds * 1000, env: step.id === 'start' ? { PORT: '4173', HOST: '127.0.0.1' } : {} });
    return { ...run, ms: Date.now() - started };
  };
  const record = (step, run, extra = {}) => push({ id: step.id, dir: step.dir, label: step.label, ok: run.code === 0, timedOut: Boolean(run.timedOut), ms: run.ms ?? 0, ...extra });
  let done = 0;
  const progress = (step) => onStep({ done, total: steps.length, step });

  // 1. Install, with the network, when the package.json files changed since the last good install.
  let installed = true;
  const installs = steps.filter((step) => step.id === 'install');
  if (installedHash && installedHash === manifestsHash(blueprint, files)) {
    for (const step of installs) push({ id: step.id, dir: step.dir, label: step.label, ok: true, cached: true, ms: 0 });
    done += installs.length;
  } else {
    await box.online?.();
    let legacyPeers = false;
    for (const step of installs) {
      if (signal?.aborted) return result;
      progress(step);
      let run = await exec(step);
      for (let attempt = 0; run.code !== 0 && attempt < 3; attempt += 1) {
        const problems = installProblems(run.output);
        let repaired = false;
        for (const { name } of problems.missingVersions) {
          for (const pkg of blueprint.packages) {
            for (const field of ['dependencies', 'devDependencies']) {
              if (pkg[field][name] && pkg[field][name] !== 'latest') {
                pkg[field][name] = 'latest';
                result.reset.push(name);
                repaired = true;
              }
            }
          }
        }
        for (const name of problems.missingPackages) {
          for (const pkg of blueprint.packages) {
            for (const field of ['dependencies', 'devDependencies']) {
              if (name in pkg[field]) {
                delete pkg[field][name];
                repaired = true;
              }
            }
          }
          if (!result.removed.includes(name)) result.removed.push(name);
          for (const [file, code] of files) {
            if (!file.endsWith('package.json') && importsPackage(code, name)) add(file, { kind: 'install', message: `The package "${name}" doesn't exist on npm, so it was removed from package.json: rewrite this without it (with code of your own or a real package).` });
          }
        }
        if (problems.peerConflict && !legacyPeers) {
          legacyPeers = true;
          result.notes.push('peer dependencies conflicted: installed with --legacy-peer-deps');
          repaired = true;
        }
        if (!repaired) break;
        await writeManifests();
        run = await exec(step, legacyPeers ? `${INSTALL} --legacy-peer-deps` : INSTALL);
      }
      record(step, run);
      done += 1;
      if (run.code !== 0) {
        installed = false;
        result.unfixable.push({ step: step.id, dir: step.dir, excerpt: excerpt(run.output) });
      }
    }
    if (installed) {
      // Pin what was added as "latest" to the version that was installed.
      const wanted = {};
      for (const pkg of blueprint.packages) {
        const names = Object.entries(deps(pkg)).filter(([, spec]) => spec === 'latest').map(([name]) => name);
        if (names.length) wanted[dirOf(pkg.path)] = names;
      }
      if (Object.keys(wanted).length) {
        const pins = await box.run(`node -e ${quote(PIN)} ${quote(JSON.stringify(wanted))}`, { timeoutMs: 60_000 });
        try {
          const versions = JSON.parse(cleanLog(pins.output).trim().split('\n').at(-1));
          for (const pkg of blueprint.packages) {
            for (const field of ['dependencies', 'devDependencies']) {
              for (const name of Object.keys(pkg[field])) {
                const version = versions[dirOf(pkg.path)]?.[name];
                if (pkg[field][name] === 'latest' && /^\d+\.\d+\.\d+/.test(version ?? '')) {
                  pkg[field][name] = `^${version}`;
                  result.pinned.push(`${name}@^${version}`);
                }
              }
            }
          }
          if (result.pinned.length) await writeManifests();
        } catch {
          result.notes.push("the installed versions couldn't be read, so packages added as latest stay latest");
        }
      }
      result.installedHash = manifestsHash(blueprint, files);
    } else result.installedHash = null;
  }
  // From here on the project's own code runs: offline.
  if (installed) result.offline = await box.offline();

  // 2. Build, types, tests and a server's start.
  for (const step of steps.filter((item) => item.id !== 'install')) {
    if (signal?.aborted) return result;
    if (!installed) {
      push({ id: step.id, dir: step.dir, label: step.label, ok: false, skipped: true, ms: 0 });
      continue;
    }
    progress(step);
    const run = await exec(step);
    const counts = step.id === 'test' ? testCounts(run.output) : null;
    done += 1;
    if (run.code === 0) {
      record(step, run, counts ? { counts } : {});
      continue;
    }
    const text = excerpt(run.output);
    const where = step.dir ? ` (${step.dir})` : '';
    const heading = run.timedOut ? `\`${step.command.split(';')[0]}\`${where} didn't finish within ${step.seconds} seconds.` : `\`${step.id === 'start' ? 'npm start' : step.command}\`${where} failed:`;
    if (step.id === 'start' && !run.timedOut && !CODE_CRASH.test(cleanLog(run.output))) {
      // Stopped for a missing setting or service (a database, a key): a note, not a fix.
      record(step, run, { needsSetup: true });
      result.notes.push(`the server${where} stopped at startup, probably for a missing setting: ${text.split('\n')[0].slice(0, 200)}`);
      continue;
    }
    record(step, run, counts ? { counts } : {});
    result.ok = false;
    const kind = step.id === 'start' ? 'runtime' : step.id;
    const exact = blame(run.output, { root: box.root, dir: step.dir, paths, blueprint });
    if (exact) {
      for (const item of exact) add(item.path, { kind, line: item.line ?? null, message: `${heading} ${item.message}\n${text}` });
      continue;
    }
    const named = filesInLog(run.output, { root: box.root, dir: step.dir, paths });
    // A failing test names the test, not what's wrong: the reviewer decides which file must change.
    if (triage && (step.id === 'test' || !named.size)) {
      const decided = await triage({ step, log: text, named: [...named.keys()] }).catch(() => null);
      if (decided?.size) {
        for (const [file, list] of decided) for (const item of list) add(file, { kind, line: null, message: `${heading} ${item.message}\n${text}` });
        continue;
      }
    }
    if (named.size) {
      for (const [file, line] of named) add(file, { kind, line, message: `${heading}\n${text}` });
    } else result.unfixable.push({ step: step.id, dir: step.dir, excerpt: text });
  }
  if (!installed) result.ok = false;
  if (result.unfixable.length) result.ok = false;
  return result;
}

/** One line for the timeline and the answer: each step and how it went. */
export function stepsSummary(steps) {
  const many = new Set(steps.map((step) => step.dir)).size > 1;
  return steps
    .map((step) => {
      const name = `${step.label}${many && step.dir ? ` (${step.dir})` : ''}`;
      if (step.skipped) return `${name}: דולג`;
      const tests = step.counts ? ` (${step.counts.failed ? `${step.counts.failed} נכשלו, ` : ''}${step.counts.passed} עברו)` : '';
      if (step.needsSetup) return `${name}: דורש הגדרות`;
      return `${name} ${step.ok ? '✓' : '✗'}${tests}`;
    })
    .join(' · ');
}
