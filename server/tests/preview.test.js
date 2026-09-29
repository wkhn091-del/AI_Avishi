// Live previews and edits, the parts that need no sandbox: which dev server a project runs, how a patch is
// checked and applied to the blueprint, and how a project's versions are rebuilt from its conversation.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { planPreview } = await import('../src/services/ai/swarm/preview.js');
const { validatePatch, projectContext } = await import('../src/services/ai/swarm/patch.js');
const { validateBlueprint } = await import('../src/services/ai/swarm/blueprint.js');
const { artifactState } = await import('../src/services/chat/artifacts.js');

const S = (text) => `${text} Every function validates its input and handles errors and edge cases exactly as the contracts say.`;
const { blueprint } = validateBlueprint({
  name: 'sums',
  title: 'מחשבון סכומים',
  summary: 'ממשק React ושרת Express.',
  stack: ['React 19', 'Vite 7', 'Express 5'],
  architecture: 'A React client; an Express server.',
  contracts: 'GET /api/tasks → Task[].',
  packages: [
    { path: 'client/package.json', type: 'module', scripts: { dev: 'vite', build: 'vite build' }, dependencies: { react: '^19.1.0', 'react-dom': '^19.1.0' }, devDependencies: { vite: '^7.1.0' } },
    { path: 'server/package.json', type: 'module', scripts: { start: 'node index.js' }, dependencies: { express: '^5.1.0' } },
  ],
  files: [
    { path: 'client/index.html', purpose: 'The page', imports: [{ from: '/src/main.jsx' }], spec: S('A root div and the module script.') },
    { path: 'client/src/main.jsx', purpose: 'Mounts the app', imports: [{ from: 'react-dom/client', names: ['createRoot'] }, { from: './App.jsx', names: ['default'] }], spec: S('Mounts App.') },
    { path: 'client/src/App.jsx', purpose: 'The list', imports: [{ from: './api.js', names: ['fetchTasks'] }], exports: [{ name: 'default' }], spec: S('Lists the tasks.') },
    { path: 'client/src/api.js', purpose: 'The API client', exports: [{ name: 'fetchTasks', signature: 'fetchTasks(): Promise<Task[]>' }], spec: S('GET /api/tasks.') },
    { path: 'server/index.js', purpose: 'The server', imports: [{ from: 'express', names: ['default'] }], spec: S('Serves the API.') },
  ],
  run: 'npm install',
});

describe('Live previews: the dev server a project runs', () => {
  test('Vite runs its dev server on the preview port, with the servers beside it', () => {
    assert.deepEqual(planPreview(blueprint, 5173), {
      port: 5173,
      web: { dir: 'client', command: 'npm run dev -- --host 0.0.0.0 --port 5173 --strictPort', kind: 'vite' },
      services: [{ dir: 'server', command: 'npm start' }],
    });
  });
  test("Next runs its own dev server; a server alone runs its npm start on the port; nothing to show is null", () => {
    const next = { packages: [{ path: 'package.json', scripts: { dev: 'next dev', start: 'next start' }, dependencies: { next: '^16.0.0' } }] };
    assert.deepEqual(planPreview(next, 4000).web, { dir: '', command: 'npm run dev -- --hostname 0.0.0.0 --port 4000', kind: 'next' });
    assert.deepEqual(planPreview(next, 4000).services, []);
    const server = { packages: [{ path: 'api/package.json', scripts: { start: 'node index.js' }, dependencies: { express: '^5.1.0' } }] };
    assert.deepEqual(planPreview(server, 5173), { port: 5173, web: { dir: 'api', command: 'npm start', env: { PORT: '5173' }, kind: 'server' }, services: [] });
    assert.equal(planPreview({ packages: [{ path: 'package.json', scripts: { test: 'node --test' }, dependencies: {} }] }), null);
    assert.equal(planPreview({ packages: [] }), null);
  });
});

describe('Edits: a patch, checked and applied to the blueprint', () => {
  const check = (raw) => validatePatch(raw, blueprint, { maxFiles: 60 });
  test('a change: the file keeps its contracts, its spec learns the update, and the blueprint stays valid', () => {
    const result = check({ summary: 'הכותרת משתנה', changes: [{ path: 'client/index.html', action: 'modify', instructions: 'Add an <h1>Sums</h1> above the root.', imports: [{ from: '/src/main.jsx' }] }] });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.patch, { summary: 'הכותרת משתנה', changes: [{ path: 'client/index.html', action: 'modify', purpose: 'The page', instructions: 'Add an <h1>Sums</h1> above the root.' }], packages: [] });
    const page = result.blueprint.files.find((file) => file.path === 'client/index.html');
    assert.match(page.spec, /^A root div and the module script\..*\n\nUpdate: Add an <h1>Sums<\/h1> above the root\.$/s);
    assert.equal(result.blueprint.files.length, 5);
  });
  test('a new file with a new package, and the importer that uses it', () => {
    const result = check({
      summary: 'שעון',
      changes: [
        { path: 'client/src/Clock.jsx', action: 'create', purpose: 'A clock', instructions: 'Shows the time with dayjs.', exports: [{ name: 'Clock', kind: 'component' }], imports: [{ from: 'dayjs', names: ['default'] }], spec: S('Shows HH:mm.') },
        { path: 'client/src/App.jsx', action: 'modify', instructions: 'Render <Clock /> above the list.', exports: [{ name: 'default' }], imports: [{ from: './api.js', names: ['fetchTasks'] }, { from: './Clock.jsx', names: ['Clock'] }] },
      ],
      packages: [{ path: 'client/package.json', type: 'module', scripts: { dev: 'vite', build: 'vite build' }, dependencies: { react: '^19.1.0', 'react-dom': '^19.1.0', dayjs: '^1.11.0' }, devDependencies: { vite: '^7.1.0' } }],
    });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.patch.packages, ['client/package.json']);
    assert.equal(result.blueprint.packages.find((pkg) => pkg.path === 'client/package.json').dependencies.dayjs, '^1.11.0');
    assert.equal(result.blueprint.files.find((file) => file.path === 'client/src/Clock.jsx').spec, S('Shows HH:mm.'));
  });
  test("what's refused: files that don't exist or already do, package.json as a file, no instructions, and a deletion that breaks an import", () => {
    const errors = (raw) => check(raw).errors.join(' | ');
    assert.match(errors([]), /one JSON object/);
    assert.match(errors({ changes: [] }), /"changes" is empty/);
    assert.match(errors({ changes: [{ path: 'client/src/Nope.jsx', action: 'modify', instructions: 'x' }] }), /doesn't exist; use "create"/);
    assert.match(errors({ changes: [{ path: 'client/src/App.jsx', action: 'create', purpose: 'x', instructions: 'x' }] }), /already exists; use "modify"/);
    assert.match(errors({ changes: [{ path: 'client/package.json', action: 'modify', instructions: 'x' }] }), /put its complete new entry in "packages"/);
    assert.match(errors({ changes: [{ path: 'client/src/App.jsx', action: 'modify' }] }), /"instructions" for client\/src\/App.jsx are missing/);
    assert.match(errors({ changes: [{ path: 'client/src/App.jsx', action: 'rename', instructions: 'x' }] }), /must be "modify", "create" or "delete"/);
    // api.js is imported by App.jsx: deleting it alone leaves the blueprint broken.
    assert.match(errors({ changes: [{ path: 'client/src/api.js', action: 'delete' }] }), /After the patch, the blueprint has a problem: .*api\.js/);
  });
  test("the architect sees the blueprint and the code, as much as fits", () => {
    const context = projectContext(blueprint, new Map([['client/src/App.jsx', 'export default function App() {}\n'], ['server/index.js', 'x'.repeat(70_000)]]));
    assert.match(context, /^# The current blueprint\n```json\n\{"name":"sums"/);
    assert.match(context, /## client\/src\/App.jsx\n```\nexport default function App\(\) \{\}\n\n```/);
    assert.match(context, /## server\/index.js\n\(1 lines, not shown: rely on the blueprint\)/);
  });
});

describe("A project's versions, rebuilt from its conversation", () => {
  const block = (path, code) => `\n\`\`\`js ${path}\n${code}\n\`\`\`\n`;
  const messages = [
    { id: 'u1', role: 'user', content: 'בנה' },
    { id: 'a1', role: 'assistant', content: `## v1${block('src/a.js', 'a1')}${block('src/b.js', 'b1')}${block('QA_REPORT.md', '# report')}`, artifact: { id: 'a1', version: 1, blueprint: { title: 'P', summary: 'first' } } },
    { id: 'u2', role: 'user', content: 'שנה', artifact: { id: 'a1' } },
    { id: 'a2', role: 'assistant', content: `## v2${block('src/a.js', 'a2')}${block('src/c.js', 'c2')}`, artifact: { id: 'a1', version: 2, base: 1, changed: ['src/a.js', 'src/c.js'], deleted: ['src/b.js'], summary: 'second', blueprint: { title: 'P' } } },
    { id: 'a3', role: 'assistant', content: 'שגיאה', error: { message: 'x' }, artifact: { id: 'a1', version: 3 } },
  ];
  test('each version is the one before it with its changes; reports are not project files; failed answers are no version', () => {
    const latest = artifactState(messages, 'a1');
    assert.deepEqual([latest.version, latest.latest, latest.messageId, latest.summary], [2, 2, 'a2', 'second']);
    assert.deepEqual(Object.fromEntries(latest.files), { 'src/a.js': 'a2\n', 'src/c.js': 'c2\n' });
    const first = artifactState(messages, 'a1', 1);
    assert.deepEqual([first.version, first.latest], [1, 2]);
    assert.deepEqual(Object.fromEntries(first.files), { 'src/a.js': 'a1\n', 'src/b.js': 'b1\n' });
    assert.equal(artifactState(messages, 'nope'), null);
  });
});
