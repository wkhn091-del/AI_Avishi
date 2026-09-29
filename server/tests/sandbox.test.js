// The sandbox: the tar stream, the plan of steps, reading real tools' errors (fixtures/sandbox-logs.json holds
// what Vite, esbuild, tsc, Node, node:test and npm really printed), the verification loop, the Docker provider
// (through fixtures/fake-docker.mjs, a stand-in CLI), the E2B provider (a stand-in SDK), access and capacity.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'stash-sandbox-'));
const cli = path.join(work, 'docker');
await fs.writeFile(cli, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, 'fixtures', 'fake-docker.mjs')}" "$@"\n`, { mode: 0o755 });
Object.assign(process.env, { SANDBOX: 'docker', SANDBOX_DOCKER_CLI: cli, SANDBOX_MAX_RUNS: '1', FAKE_DOCKER_ROOT: path.join(work, 'containers'), FAKE_DOCKER_LOG: path.join(work, 'docker.log') });
for (const name of ['SANDBOX_ACCESS', 'SANDBOX_DOCKER_IMAGE', 'SANDBOX_DOCKER_NETWORK', 'SANDBOX_MEMORY_MB', 'SANDBOX_CPUS']) delete process.env[name];
const LOGS = JSON.parse(await fs.readFile(path.join(here, 'fixtures', 'sandbox-logs.json'), 'utf8'));

const { config } = await import('../src/config.js');
const { tarOf } = await import('../src/services/ai/swarm/sandbox/tar.js');
const { DockerSandbox, DOCKER_ROOT } = await import('../src/services/ai/swarm/sandbox/docker.js');
const { E2BSandbox, useE2BModule } = await import('../src/services/ai/swarm/sandbox/e2b.js');
const { SandboxError, openSandbox, sandboxFor } = await import('../src/services/ai/swarm/sandbox/index.js');
const verify = await import('../src/services/ai/swarm/verify.js');
const { validateBlueprint } = await import('../src/services/ai/swarm/blueprint.js');

after(() => fs.rm(work, { recursive: true, force: true }));
const dockerLog = async () => (await fs.readFile(process.env.FAKE_DOCKER_LOG, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const SPEC = 'Everything this file does, in detail: every function, its inputs and outputs, its errors and edge cases, exactly as the contracts say.';
function plan(packages, files) {
  const { blueprint, errors } = validateBlueprint({ name: 'p', summary: 'A project.', packages, files: files.map((file) => ({ spec: SPEC, purpose: 'x', ...file })) });
  assert.deepEqual(errors, []);
  return blueprint;
}

describe('What runs in the sandbox', () => {
  test('tar: every file, long paths and Hebrew included, extracts with the system tar', async () => {
    const long = `${'deep/'.repeat(24)}file.js`;
    const files = new Map([['README.md', '# שלום\n'], ['src/App.jsx', 'export default 1;\n'], [long, 'const a = 1;\n'], ['empty.txt', '']]);
    const dir = path.join(work, 'tar-out');
    await fs.mkdir(dir);
    execFileSync('tar', ['-x', '-f', '-', '-C', dir], { input: tarOf(files) });
    for (const [file, content] of files) assert.equal(await fs.readFile(path.join(dir, file), 'utf8'), content, file);
  });

  test('the steps come from the package.json files: installs, the scripts that exist, types where TypeScript is set up, a start for servers', () => {
    const one = plan(
      [{ path: 'package.json', scripts: { build: 'vite build', test: 'vitest run', start: 'node server.js' }, dependencies: { express: '^5.1.0' }, devDependencies: { typescript: '^5.9.0', vite: '^7.1.0', vitest: '^3.2.0' } }],
      [{ path: 'server.js' }, { path: 'tsconfig.json' }],
    );
    assert.deepEqual(
      verify.planSteps(one, new Map([['tsconfig.json', '{}']]), config.sandbox).map((step) => [step.id, step.dir, step.command.split(';')[0], step.label]),
      [
        ['install', '', verify.INSTALL, 'התקנה'],
        ['build', '', 'npm run build', 'בנייה'],
        ['types', '', 'npx --no-install tsc --noEmit --pretty false', 'בדיקת טיפוסים'],
        ['test', '', 'npm test', 'בדיקות'],
        ['start', '', '[ -f .env ] || [ ! -f .env.example ] || cp .env.example .env', 'הפעלת השרת'],
      ],
    );
    // Workspaces: one install at the root; the root's build runs the workspaces' own; npm's placeholder test is no test.
    const workspaces = plan(
      [
        { path: 'package.json', workspaces: ['packages/*'], scripts: { build: 'npm run build --workspaces', test: 'echo "Error: no test specified" && exit 1' } },
        { path: 'packages/web/package.json', scripts: { build: 'vite build', test: 'vitest run' }, devDependencies: { vite: '^7.1.0', vitest: '^3.2.0' } },
        { path: 'packages/api/package.json', scripts: { start: 'node index.js' }, dependencies: { fastify: '^5.0.0' } },
      ],
      [{ path: 'packages/web/src/main.js' }, { path: 'packages/api/index.js' }],
    );
    assert.deepEqual(verify.planSteps(workspaces, new Map(), config.sandbox).map((step) => `${step.id}:${step.dir}`), ['install:', 'build:', 'test:packages/web', 'start:packages/api']);
    // Two packages and no root: each installs; a Vite start script isn't a server to probe.
    const two = plan(
      [
        { path: 'client/package.json', scripts: { build: 'vite build', start: 'vite' }, devDependencies: { vite: '^7.1.0' } },
        { path: 'server/package.json', scripts: { start: 'node index.js', test: 'node --test' } },
      ],
      [{ path: 'client/src/main.js' }, { path: 'server/index.js' }],
    );
    assert.deepEqual(verify.planSteps(two, new Map(), config.sandbox).map((step) => `${step.id}:${step.dir}`), ['install:client', 'install:server', 'build:client', 'test:server', 'start:server']);
    assert.deepEqual(verify.planSteps(plan([], [{ path: 'index.html' }]), new Map(), config.sandbox), [], 'no package.json, nothing to run');
  });
});

describe("Reading the tools' real errors", () => {
  const paths = new Set(['client/src/App.jsx', 'client/src/api.js', 'client/src/main.jsx', 'client/src/bad.ts', 'server/index.js', 'server/util.js', 'server/util.test.js']);
  const blueprint = { files: [{ path: 'client/src/api.js', exports: [{ name: 'fetchTasks' }] }, { path: 'server/util.js', exports: [{ name: 'helper' }] }] };
  const at = (dir, plan = blueprint) => ({ root: DOCKER_ROOT, dir, paths, blueprint: plan });

  test('the message says which file must change: the importer of a missing export, or the exporter that promised it', () => {
    assert.deepEqual(verify.blame(LOGS.build1, at('client')), [{ path: 'client/src/App.jsx', message: 'Imports "fetchTask" from "src/api.js", which doesn\'t export it.' }]);
    const promised = { files: [{ path: 'client/src/api.js', exports: [{ name: 'fetchTask' }] }] };
    assert.deepEqual(verify.blame(LOGS.build1, at('client', promised)), [{ path: 'client/src/api.js', message: 'Must export "fetchTask": the blueprint promises it, and client/src/App.jsx imports it.' }]);
    assert.deepEqual(verify.blame(LOGS.build2, at('client')), [{ path: 'client/src/App.jsx', message: 'Imports "./missing.css", which the build can\'t find.' }]);
    assert.deepEqual(verify.blame(LOGS.node1, at('server')), [{ path: 'server/index.js', line: 1, message: 'Imports "missing" from "./util.js", which doesn\'t export it.' }]);
    const types = verify.blame(LOGS.tsc, at('client'));
    assert.deepEqual(types.map((item) => [item.path, item.line]), [['client/src/bad.ts', 1]], "errors inside node_modules aren't the project's");
    assert.match(types[0].message, /line 1: TS2322 Type 'string' is not assignable to type 'number'\./);
  });

  test('otherwise the paths in the log, with the line: esbuild, Node and node:test', () => {
    assert.equal(verify.blame(LOGS.build3, at('client')), null);
    assert.deepEqual([...verify.filesInLog(LOGS.build3, at('client'))], [['client/src/App.jsx', 4]]);
    assert.deepEqual([...verify.filesInLog(LOGS.node2, at('server'))], [['server/index.js', null]]);
    assert.deepEqual([...verify.filesInLog(LOGS.test, at('server'))], [['server/util.test.js', 4]]);
    const text = verify.excerpt(LOGS.build1);
    assert.match(text, /^✗ Build failed in [\d.]+m?s\nerror during build:\nsrc\/App\.jsx \(1:9\): "fetchTask" is not exported/);
    assert.doesNotMatch(text, /getRollupError|node_modules/, 'library stack frames are left out');
  });

  test("npm's missing packages and versions, and test counts from node:test, Vitest and Jest", () => {
    assert.deepEqual(verify.installProblems(LOGS.e404), { missingVersions: [], missingPackages: ['stash-no-such-package-9f3k'], peerConflict: false });
    assert.deepEqual(verify.installProblems(LOGS.etarget), { missingVersions: [{ name: 'react', spec: '^99.0.0' }], missingPackages: [], peerConflict: false });
    assert.equal(verify.installProblems('npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree').peerConflict, true);
    assert.deepEqual(verify.testCounts(LOGS.test), { passed: 0, failed: 1 });
    assert.deepEqual(verify.testCounts(' Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 2 passed (3)'), { passed: 2, failed: 1 });
    assert.deepEqual(verify.testCounts('      Tests  4 passed (4)'), { passed: 4, failed: 0 });
    assert.deepEqual(verify.testCounts('Tests:       1 failed, 2 passed, 3 total'), { passed: 2, failed: 1 });
    assert.deepEqual(verify.testCounts('Tests:       5 passed, 5 total'), { passed: 5, failed: 0 });
    assert.equal(verify.testCounts('no summary here'), null);
  });
});

describe('The verification loop', () => {
  class FakeBox {
    constructor(handler) {
      this.handler = handler;
      this.root = DOCKER_ROOT;
      this.events = [];
    }
    async writeFiles(files) {
      this.events.push(`write:${[...files.keys()].join(',')}`);
    }
    async run(command, { cwd = '' } = {}) {
      this.events.push(`run:${cwd}:${command}`);
      return { timedOut: false, ...this.handler(command, cwd) };
    }
    async online() {
      this.events.push('online');
    }
    async offline() {
      this.events.push('offline');
      return true;
    }
  }
  const project = () =>
    plan(
      [
        { path: 'client/package.json', scripts: { build: 'vite build' }, dependencies: { react: '^19.1.0' }, devDependencies: { vite: '^7.1.0' } },
        { path: 'server/package.json', scripts: { start: 'node index.js', test: 'node --test' }, dependencies: { cors: 'latest', express: '^5.1.0', 'left-pad': '^99.0.0', 'stash-no-such-package': '^1.0.0' } },
      ],
      [{ path: 'client/src/App.jsx' }, { path: 'client/src/api.js', exports: [{ name: 'fetchTasks' }] }, { path: 'server/index.js' }, { path: 'server/util.js', exports: [{ name: 'helper' }] }, { path: 'server/util.test.js' }],
    );

  test('install repairs (a missing version becomes latest, a missing package is removed), pins, then real errors turned into issues', async () => {
    const blueprint = project();
    const files = new Map([
      ['client/package.json', ''],
      ['server/package.json', ''],
      ['client/src/App.jsx', "import { fetchTask } from './api.js';\n"],
      ['client/src/api.js', 'export const fetchTasks = async () => [];\n'],
      ['server/index.js', "import express from 'express';\nimport pad from 'stash-no-such-package';\n"],
      ['server/util.js', 'export const helper = () => 1;\n'],
      ['server/util.test.js', "import { helper } from './util.js';\n"],
    ]);
    const box = new FakeBox((command, cwd) => {
      if (command.includes('npm install') && cwd === 'server') {
        const deps = blueprint.packages.find((pkg) => pkg.path === 'server/package.json').dependencies;
        if (deps['left-pad'] === '^99.0.0') return { code: 1, output: LOGS.etarget.replace('react@', 'left-pad@') };
        if ('stash-no-such-package' in deps) return { code: 1, output: LOGS.e404.replaceAll('stash-no-such-package-9f3k', 'stash-no-such-package') };
        return { code: 0, output: 'added 4 packages in 1s\n' };
      }
      if (command.includes('npm install')) return { code: 0, output: 'added 2 packages in 1s\n' };
      if (command.startsWith('node -e')) return { code: 0, output: '{"server":{"cors":"2.8.5","left-pad":"1.3.0"}}\n' };
      if (command.includes('npm run build')) return { code: 1, output: LOGS.build1.replaceAll('/home/node/app/client', '/home/node/app/client') };
      if (command.includes('npm test')) return { code: 1, output: LOGS.test };
      if (command.includes('npm start')) return { code: 1, output: 'Error: DATABASE_URL is not set: point it at your PostgreSQL database\n' };
      return { code: 127, output: `unexpected: ${command}` };
    });
    const triaged = [];
    const result = await verify.verifyProject({
      box,
      files,
      blueprint,
      settings: config.sandbox,
      triage: async ({ step, named }) => {
        triaged.push([step.id, named]);
        return new Map([['server/util.js', [{ message: 'helper must return 2, as the spec says.' }]]]);
      },
    });
    assert.equal(result.ok, false);
    assert.deepEqual([result.reset, result.removed, result.pinned], [['left-pad'], ['stash-no-such-package'], ['cors@^2.8.5', 'left-pad@^1.3.0']]);
    assert.deepEqual(JSON.parse(files.get('server/package.json')).dependencies, { cors: '^2.8.5', express: '^5.1.0', 'left-pad': '^1.3.0' }, 'the package.json files, repaired and pinned');
    assert.deepEqual(
      [...result.issues].map(([file, list]) => [file, list.map((issue) => issue.kind)]),
      [['server/index.js', ['install']], ['client/src/App.jsx', ['build']], ['server/util.js', ['test']]],
    );
    assert.match(result.issues.get('server/index.js')[0].message, /The package "stash-no-such-package" doesn't exist on npm/);
    assert.match(result.issues.get('client/src/App.jsx')[0].message, /^`npm run build` \(client\) failed: Imports "fetchTask" from "src\/api\.js", which doesn't export it\.\n✗ Build failed in [\d.]+m?s\nerror during build:/);
    assert.deepEqual(triaged, [['test', ['server/util.test.js']]], 'a failing test goes to the triage with the files the log names');
    assert.equal(result.issues.get('server/util.js')[0].message.split('\n')[0], '`npm test` (server) failed: helper must return 2, as the spec says.');
    assert.match(result.notes.join(), /the server \(server\) stopped at startup, probably for a missing setting: Error: DATABASE_URL is not set/, 'a missing setting is a note, not a fix');
    assert.equal(
      verify.stepsSummary(result.steps),
      'התקנה (client) ✓ · התקנה (server) ✓ · בנייה (client) ✗ · בדיקות (server) ✗ (1 נכשלו, 0 עברו) · הפעלת השרת (server): דורש הגדרות',
    );
    // The network: on for the installs, off before any of the project's code runs.
    const offline = box.events.indexOf('offline');
    assert.ok(box.events.indexOf('online') < box.events.findIndex((event) => event.includes('npm install')));
    assert.ok(offline > box.events.findLastIndex((event) => event.includes('npm install')) && offline < box.events.findIndex((event) => event.includes('npm run build')));
    assert.equal(box.events.filter((event) => event.includes('npm install') && event.includes(':server:')).length, 3, 'the server install: twice repaired, then good');

    // The next round: the package.json files are what was installed, so no install and no pins.
    const again = new FakeBox(() => ({ code: 0, output: '# pass 1\n# fail 0\n' }));
    const next = await verify.verifyProject({ box: again, files, blueprint, settings: config.sandbox, installedHash: result.installedHash });
    assert.equal(next.ok, true);
    assert.ok(!again.events.some((event) => event.includes('npm install') || event.includes('node -e') || event === 'online'));
    assert.deepEqual(next.steps.filter((step) => step.cached).map((step) => step.dir), ['client', 'server']);
  });

  test('a server that crashes on its own code goes back to be fixed; a test runner that hangs is stopped and reported', async () => {
    const blueprint = project();
    for (const pkg of blueprint.packages) for (const name of ['left-pad', 'stash-no-such-package']) delete pkg.dependencies[name];
    const files = new Map([['server/index.js', "import express from 'express';\n"], ['server/util.js', ''], ['server/util.test.js', ''], ['client/src/App.jsx', ''], ['client/src/api.js', '']]);
    const box = new FakeBox((command) => {
      if (command.includes('npm test')) return { code: 124, timedOut: true, output: 'watching for file changes…' };
      if (command.includes('npm start')) return { code: 1, output: LOGS.node1 };
      if (command.startsWith('node -e')) return { code: 0, output: '{"server":{"cors":"2.8.5"}}' };
      return { code: 0, output: 'ok' };
    });
    const result = await verify.verifyProject({ box, files, blueprint, settings: config.sandbox });
    assert.equal(result.issues.get('server/index.js')[0].kind, 'runtime');
    assert.match(result.issues.get('server/index.js')[0].message, /^`npm start` \(server\) failed: Imports "missing" from "\.\/util\.js"/);
    assert.deepEqual(result.unfixable.map((item) => item.step), ['test'], 'no file named and no triage: reported for the project');
    assert.equal(result.steps.find((step) => step.id === 'test').timedOut, true);
  });
});

describe('The providers', () => {
  test('Docker: a locked-down container, the project copied in as one tar stream, commands under a time limit, the network cut and the container removed', async () => {
    const box = await DockerSandbox.open(config.sandbox.docker, 60);
    await box.writeFiles(new Map([['client/src/App.jsx', 'export default () => <h1>שלום</h1>;\n'], ['package.json', '{}\n']]));
    const listing = await box.run('find . -type f | sort && cat client/src/App.jsx');
    assert.equal(listing.code, 0);
    assert.match(listing.output, /\.\/client\/src\/App\.jsx\n\.\/package\.json\nexport default \(\) => <h1>שלום<\/h1>;/);
    assert.deepEqual(await box.run('echo broken >&2; exit 3', { cwd: 'client' }), { code: 3, output: 'broken\n', timedOut: false });
    const slow = await box.run('sleep 5', { timeoutMs: 1_000 });
    assert.deepEqual([slow.code, slow.timedOut], [124, true]);
    assert.equal(await box.offline(), true);
    assert.equal(await box.offline(), true);
    await box.online();
    await box.close();
    const log = await dockerLog();
    const run = log.find((args) => args[0] === 'run');
    for (const flag of ['-d', '--rm', '--init', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=512', '--memory=2048m', '--memory-swap=2048m', '--cpus=2', '--network=bridge', 'node:22-bookworm']) assert.ok(run.includes(flag), flag);
    assert.deepEqual(run.slice(run.indexOf('--user'), run.indexOf('--user') + 2), ['--user', 'node']);
    assert.match(run.at(-1), /^mkdir -p \/home\/node\/app && exec sleep 60$/, 'the container ends itself when its time is up');
    const tar = log.find((args) => args[0] === 'exec' && args.includes('tar'));
    assert.deepEqual(tar.slice(0, 4), ['exec', '-i', '-u', 'node']);
    const command = log.find((args) => args[0] === 'exec' && args.includes('timeout'));
    assert.deepEqual(command.slice(command.indexOf('timeout'), command.indexOf('timeout') + 5), ['timeout', '-k', '5', '300', 'sh']);
    assert.ok(command.includes('CI=true') && command.includes('NO_COLOR=1'));
    assert.deepEqual(log.filter((args) => args[0] === 'network').map((args) => args[1]), ['disconnect', 'connect'], 'disconnected once, connected again');
    assert.deepEqual(log.at(-1).slice(0, 2), ['rm', '-f']);
  });

  test("Docker that isn't installed or isn't running is a reason in Hebrew, not a crash", async () => {
    await assert.rejects(DockerSandbox.open({ ...config.sandbox.docker, cli: path.join(work, 'no-such-docker') }, 60), (error) => error instanceof SandboxError && /Docker לא מותקן בשרת/.test(error.message));
    await fs.mkdir(process.env.FAKE_DOCKER_ROOT, { recursive: true });
    await fs.writeFile(path.join(process.env.FAKE_DOCKER_ROOT, 'down'), '');
    await assert.rejects(DockerSandbox.open(config.sandbox.docker, 60), /השרת לא מצליח להתחבר ל-Docker: Cannot connect to the Docker daemon/);
    await fs.rm(path.join(process.env.FAKE_DOCKER_ROOT, 'down'));
  });

  test('E2B: a microVM nobody can reach, Node checked first, exit codes and time limits read, internet off and on, killed at the end', async () => {
    const created = [];
    class FakeSandbox {
      static noNode = false;
      static async create(...args) {
        created.push(args);
        return new FakeSandbox();
      }
      constructor() {
        this.writes = [];
        this.runs = [];
        this.network = [];
        this.killed = false;
        this.files = { write: async (file, content) => this.writes.push([file, content]) };
        this.commands = {
          run: async (command, options) => {
            this.runs.push([command, options]);
            if (command.startsWith('node --version')) {
              if (FakeSandbox.noNode) throw Object.assign(new Error('exit status 127'), { name: 'CommandExitError', exitCode: 127, stdout: '', stderr: 'node: not found\n' });
              return { exitCode: 0, stdout: 'v22.12.0\n', stderr: '' };
            }
            if (command === 'fail') throw Object.assign(new Error('exit status 2'), { name: 'CommandExitError', exitCode: 2, stdout: '', stderr: 'boom\n' });
            if (command === 'slow') throw Object.assign(new Error('Request timed out'), { name: 'TimeoutError' });
            return { exitCode: 0, stdout: 'ok\n', stderr: '' };
          },
        };
      }
      async updateNetwork(options) {
        this.network.push(options);
      }
      async kill() {
        this.killed = true;
      }
    }
    useE2BModule({ Sandbox: FakeSandbox });
    await assert.rejects(E2BSandbox.open({ apiKey: '', template: '' }, 60), /חסר מפתח E2B_API_KEY/);
    const box = await E2BSandbox.open({ apiKey: 'e2b-key', template: '' }, 600);
    assert.deepEqual(created, [[{ apiKey: 'e2b-key', timeoutMs: 600_000, allowInternetAccess: true, allowPublicTraffic: false, metadata: { app: 'stash' } }]]);
    await box.writeFiles(new Map([['a.js', 'x'], ['src/b.js', 'y']]));
    assert.deepEqual(box.box.writes.sort(), [['/home/user/app/a.js', 'x'], ['/home/user/app/src/b.js', 'y']]);
    assert.deepEqual(await box.run('echo hi', { cwd: 'src' }), { code: 0, output: 'ok\n', timedOut: false });
    assert.equal(box.box.runs.at(-1)[1].cwd, '/home/user/app/src');
    assert.equal(box.box.runs.at(-1)[1].envs.CI, 'true');
    assert.deepEqual(await box.run('fail'), { code: 2, output: 'boom\n', timedOut: false });
    assert.deepEqual(await box.run('slow'), { code: 124, output: 'Request timed out', timedOut: true });
    assert.equal(await box.offline(), true);
    assert.equal(await box.offline(), true);
    await box.online();
    assert.deepEqual(box.box.network, [{ allowInternetAccess: false }, { allowInternetAccess: true }]);
    await box.close();
    assert.equal(box.box.killed, true);
    FakeSandbox.noNode = true;
    await assert.rejects(E2BSandbox.open({ apiKey: 'e2b-key', template: 'my-template' }, 600), /בתבנית של E2B אין Node\.js/);
    assert.equal(created.at(-1)[0], 'my-template', 'a template by name');
  });

  test('only admins get the sandbox unless SANDBOX_ACCESS=everyone, and at most SANDBOX_MAX_RUNS projects use it at once', async () => {
    assert.deepEqual(sandboxFor({ isAdmin: true }), { provider: 'docker', label: 'Docker' });
    assert.equal(sandboxFor({ isAdmin: false }), null);
    assert.equal(sandboxFor(null), null);
    const first = await openSandbox();
    let second = null;
    const waiting = openSandbox().then((box) => {
      second = box;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(second, null, 'the second project waits for the first');
    await first.close();
    await waiting;
    assert.ok(second, 'and gets the slot as soon as it is free');
    await second.close();
    await second.close();
  });
});
