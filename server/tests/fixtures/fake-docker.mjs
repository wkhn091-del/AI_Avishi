// A stand-in for the docker CLI in tests. A container is a folder under FAKE_DOCKER_ROOT, and commands run
// in it for real (tar, timeout, node), except npm, which is acted out from the project's files with the
// real tools' messages: an install writes node_modules/<name>/package.json, a Vite build rejects top-level
// await, node --test fails while server/util.js subtracts, and a server needing DATABASE_URL stops at startup.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = '/home/node/app';
const base = process.env.FAKE_DOCKER_ROOT;
const args = process.argv.slice(2);
mkdirSync(base, { recursive: true });
appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify(args)}\n`);
const out = (text, code = 0) => {
  process.stdout.write(text);
  process.exit(code);
};
const container = (name) => path.join(base, name);
const appOf = (name) => path.join(container(name), 'app');
const walk = (dir) => (existsSync(dir) ? readdirSync(dir).flatMap((entry) => (entry === 'node_modules' ? [] : statSync(path.join(dir, entry)).isDirectory() ? walk(path.join(dir, entry)) : [path.join(dir, entry)])) : []);

function play(script, cwd, name) {
  const inside = (file) => path.join(ROOT, path.relative(appOf(name), file));
  const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  if (/npm install/.test(script)) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if ('stash-no-such-package' in deps) out(`npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/stash-no-such-package - Not found\nnpm error 404\nnpm error 404  'stash-no-such-package@${deps['stash-no-such-package']}' is not in this registry.\n`, 1);
    const wrong = Object.entries(deps).find(([, spec]) => spec === '^99.0.0');
    if (wrong) out(`npm error code ETARGET\nnpm error notarget No matching version found for ${wrong[0]}@^99.0.0.\nnpm error notarget In most cases you or one of your dependencies are requesting\n`, 1);
    for (const [dep, spec] of Object.entries(deps)) {
      const version = spec === 'latest' ? '2.8.5' : (spec.match(/\d+\.\d+\.\d+/)?.[0] ?? '1.0.0');
      mkdirSync(path.join(cwd, 'node_modules', dep), { recursive: true });
      writeFileSync(path.join(cwd, 'node_modules', dep, 'package.json'), JSON.stringify({ name: dep, version }));
    }
    out(`added ${Object.keys(deps).length} packages in 1s\n`);
  }
  if (/npm run build/.test(script)) {
    for (const file of walk(path.join(cwd, 'src'))) {
      const index = readFileSync(file, 'utf8').split('\n').findIndex((line) => /^const \w+ = await /.test(line));
      if (index !== -1) {
        out(`vite v7.3.6 building client environment for production...\ntransforming...\n✗ Build failed in 90ms\nerror during build:\n[vite:esbuild] Transform failed with 1 error:\n${inside(file)}:${index + 1}:14: ERROR: Top-level await is not available in the configured target environment ("chrome87", "edge88", "es2020", "firefox78", "safari14" + 2 overrides)\nfile: ${inside(file)}:${index + 1}:14\n`, 1);
      }
    }
    out('vite v7.3.6 building client environment for production...\n✓ 31 modules transformed.\n✓ built in 912ms\n');
  }
  if (/npm test/.test(script)) {
    const util = existsSync(path.join(cwd, 'util.js')) ? readFileSync(path.join(cwd, 'util.js'), 'utf8') : '';
    if (/a - b/.test(util)) {
      out(`> test\n> node --test\n\nTAP version 13\n# Subtest: add sums two numbers\nnot ok 1 - add sums two numbers\n  ---\n  duration_ms: 1.2\n  location: '${inside(path.join(cwd, 'util.test.js'))}:5:1'\n  failureType: 'testCodeFailure'\n  error: |-\n    Expected values to be strictly equal:\n\n    -1 !== 5\n\n  code: 'ERR_ASSERTION'\n  stack: |-\n    TestContext.<anonymous> (file://${inside(path.join(cwd, 'util.test.js'))}:6:10)\n    Test.runInAsyncScope (node:async_hooks:214:14)\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 0\n# fail 1\n`, 1);
    }
    out('TAP version 13\n# Subtest: add sums two numbers\nok 1 - add sums two numbers\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n');
  }
  if (/npm start/.test(script)) {
    const index = existsSync(path.join(cwd, 'index.js')) ? readFileSync(path.join(cwd, 'index.js'), 'utf8') : '';
    if (/process\.env\.DATABASE_URL/.test(index) && !existsSync(path.join(cwd, '.env'))) out('Error: DATABASE_URL is not set: point it at your PostgreSQL database\n', 1);
    if (/does-not-exist/.test(index)) out(`file://${inside(path.join(cwd, 'index.js'))}:2\nimport { nothing } from './util.js';\n         ^^^^^^^\nSyntaxError: The requested module './util.js' does not provide an export named 'nothing'\n`, 1);
    out('Server listening on 4173\n[stash] still running after 8s\n');
  }
  out(`unknown npm command: ${script}\n`, 1);
}

if (args[0] === 'version') {
  if (existsSync(path.join(base, 'down'))) out('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n', 1);
  out('27.3.1\n');
}
if (args[0] === 'run') {
  mkdirSync(appOf(args[args.indexOf('--name') + 1]), { recursive: true });
  out(`${'f'.repeat(64)}\n`);
}
if (args[0] === 'network') out('');
if (args[0] === 'rm') {
  // A container's background processes (a preview's dev servers) end with it.
  const pids = path.join(container(args.at(-1)), '.stash');
  for (const file of existsSync(pids) ? readdirSync(pids).filter((entry) => entry.endsWith('.pid')) : []) {
    try {
      process.kill(-Number(readFileSync(path.join(pids, file), 'utf8')), 'SIGKILL');
    } catch {
      // already gone
    }
  }
  rmSync(container(args.at(-1)), { recursive: true, force: true });
  out(`${args.at(-1)}\n`);
}
if (args[0] === 'exec') {
  let index = 1;
  let workdir = ROOT;
  let interactive = false;
  let detached = false;
  const env = {};
  while (args[index].startsWith('-')) {
    if (args[index] === '-i') {
      interactive = true;
      index += 1;
    } else if (args[index] === '-d') {
      detached = true;
      index += 1;
    } else if (args[index] === '-w') {
      workdir = args[index + 1];
      index += 2;
    } else if (args[index] === '-e') {
      const [key, ...value] = args[index + 1].split('=');
      env[key] = value.join('=');
      index += 2;
    } else index += 2; // -u node
  }
  const name = args[index];
  const command = args.slice(index + 1);
  if (!existsSync(container(name))) out(`Error response from daemon: No such container: ${name}\n`, 1);
  const cwd = path.join(appOf(name), path.relative(ROOT, workdir));
  const script = command[0] === 'timeout' ? command.at(-1) : '';
  if (/\bnpm (install|run build|test|start)\b/.test(script)) play(script, cwd, name);
  // Paths in the container's home, as arguments or inside scripts, are the container's folder.
  const real = command.map((part) => part.replaceAll('/home/node/', `${container(name)}/`));
  if (detached) {
    // A preview's dev server (npm run dev, npm start) is acted out by fake-devserver.mjs: it serves the folder, on a
    // free port it writes down for the relay below, since tests share one network.
    const at = real.indexOf('stash') + 2;
    const port = /--port (\d+)/.exec(real[at] ?? '')?.[1] ?? env.PORT ?? '';
    if (/\bnpm (run dev|start)\b/.test(real[at] ?? '')) real[at] = real[at].replace(/\bnpm (run dev|start)\b.*$/, `node ${JSON.stringify(path.join(path.dirname(new URL(import.meta.url).pathname), 'fake-devserver.mjs'))}`);
    spawn(real[0], real.slice(1), { cwd: existsSync(cwd) ? cwd : appOf(name), env: { ...process.env, ...env, FAKE_DEV_PORT: port, FAKE_DEV_DIR: container(name) }, detached: true, stdio: 'ignore' }).unref();
    out('');
  }
  if (interactive && real[0] === 'node' && real[1] === '-e') {
    // The preview relay: connected to the port the fake dev server wrote down, with stdin and stdout passed through.
    const file = path.join(container(name), '.stash', `port-${real[3]}`);
    for (let waited = 0; !existsSync(file) && waited < 3_000; waited += 100) spawnSync('sleep', ['0.1']);
    if (!existsSync(file)) process.exit(1);
    const relay = spawnSync(process.execPath, ['-e', real[2], readFileSync(file, 'utf8').trim()], { stdio: 'inherit' });
    process.exit(relay.status ?? 1);
  }
  const result = spawnSync(real[0], real.slice(1), { cwd: existsSync(cwd) ? cwd : appOf(name), input: interactive ? readFileSync(0) : undefined, env: { ...process.env, ...env }, encoding: 'utf8' });
  out(`${result.stdout ?? ''}${result.stderr ?? ''}`, result.status ?? 1);
}
out(`fake docker: unsupported ${args.join(' ')}\n`, 1);
