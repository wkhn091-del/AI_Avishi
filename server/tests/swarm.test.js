// The swarm's building blocks: the blueprint's validation, the QA compiler's deterministic checks,
// and the helpers around the micro-agents. The whole flow, through the chat, is in chatPipeline.test.js.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { manifestFiles, packageOf, parseBlueprint, resolveImport, validateBlueprint } from '../src/services/ai/swarm/blueprint.js';
import { checkProject, placeholderIn } from '../src/services/ai/swarm/checks.js';
import { fenceFor, fileBrief, stripFence } from '../src/services/ai/swarm/agents.js';
import { pool } from '../src/services/ai/swarm/index.js';

const spec = (text) => `${text} Every function validates its input, handles errors and edge cases, and returns exactly what the contracts say.`;
const PLAN = {
  name: 'Todo App',
  title: 'משימות',
  summary: 'אפליקציית משימות עם שרת.',
  stack: ['React 19', 'Express 5'],
  architecture: 'A React client talks to an Express API.',
  contracts: 'GET /api/tasks → [{ id, title, done }]',
  packages: [{ path: 'package.json', type: 'module', scripts: { dev: 'vite' }, dependencies: { react: '^19.1.0', express: '^5.1.0', 'react-dom': '^19.1.0' }, devDependencies: { vite: '^7.1.0' } }],
  files: [
    { path: 'index.html', purpose: 'The entry page', imports: [{ from: '/src/main.jsx' }], spec: spec('A root div and the module script.') },
    { path: './src/main.jsx', purpose: 'Mounts the app', imports: [{ from: 'react-dom/client', names: ['createRoot'] }, { from: './App.jsx', names: ['default'] }], spec: spec('Mounts App into #root.') },
    { path: 'src/App.jsx', purpose: 'The task list', imports: [{ from: './api.js', names: ['fetchTasks'] }, 'react'], exports: [{ name: 'default', kind: 'component' }], spec: spec('Loads and lists the tasks.') },
    { path: 'src/api.js', purpose: 'The API client', exports: [{ name: 'fetchTasks', kind: 'function', signature: 'fetchTasks(): Promise<Task[]>' }], spec: spec('GETs /api/tasks.') },
    { path: 'server/index.js', purpose: 'The server', imports: [{ from: 'express', names: ['default'] }, { from: 'node:path' }, { from: 'fs' }], spec: spec('Express with GET /api/tasks.') },
  ],
  run: 'npm install && npm run dev',
};
const valid = () => validateBlueprint(structuredClone(PLAN)).blueprint;

describe('The blueprint', () => {
  test('a valid blueprint is normalized: paths, names, languages, and package.json files written from it', () => {
    const { blueprint, errors } = validateBlueprint(structuredClone(PLAN));
    assert.deepEqual(errors, []);
    assert.equal(blueprint.name, 'todo-app');
    assert.deepEqual(blueprint.files.map((file) => [file.path, file.language]), [['index.html', 'html'], ['src/main.jsx', 'jsx'], ['src/App.jsx', 'jsx'], ['src/api.js', 'js'], ['server/index.js', 'js']]);
    assert.deepEqual(blueprint.files[2].imports, [{ from: './api.js', names: ['fetchTasks'] }, { from: 'react', names: [] }], 'a bare string is an import too');
    const [manifest] = manifestFiles(blueprint);
    assert.equal(manifest.path, 'package.json');
    const json = JSON.parse(manifest.content);
    assert.deepEqual([json.name, json.version, json.private, json.type], ['todo-app', '1.0.0', true, 'module']);
    assert.deepEqual(Object.keys(json.dependencies), ['express', 'react', 'react-dom'], 'sorted');
    assert.ok(manifest.content.endsWith('}\n'));
  });

  test("what goes back to the architect: paths the ZIP can't take, binaries, manifests in files, duplicates, aliases, URLs, undeclared packages, thin specs, too many files", () => {
    const plan = structuredClone(PLAN);
    plan.files.push(
      { path: '../outside.js', spec: spec('x') },
      { path: 'src/pages/[id].jsx', spec: spec('x') },
      { path: 'public/logo.png', spec: spec('x') },
      { path: 'client/package.json', spec: spec('x') },
      { path: 'src/api.js', spec: spec('again') },
      { path: 'src/thin.js', spec: 'Utils.' },
      { path: 'src/uses.js', imports: [{ from: '@/lib/x.js' }, { from: 'https://cdn.example.com/three.js' }, { from: 'lodash' }, { from: './nowhere.js' }], spec: spec('x') },
    );
    const { blueprint, errors } = validateBlueprint(plan, { maxFiles: 8 });
    assert.equal(blueprint, null);
    const expected = [
      /"\.\.\/outside\.js": must be a relative path inside the project/,
      /"src\/pages\/\[id\]\.jsx": use letters, digits/,
      /"public\/logo\.png": binary files can't be generated/,
      /client\/package\.json: describe package\.json files in "packages"/,
      /src\/api\.js is listed twice/,
      /src\/thin\.js: the spec is too short/,
      /imports "@\/lib\/x\.js": use a relative path, not an alias/,
      /imports "https:\/\/cdn\.example\.com\/three\.js": use a package from the dependencies, not a URL/,
      /imports the package "lodash", which no package\.json above it lists/,
      /imports "\.\/nowhere\.js", which isn't in the file tree/,
      /The plan has 12 files and the limit is 8/,
    ];
    for (const pattern of expected) assert.ok(errors.some((error) => pattern.test(error)), `${pattern} in ${JSON.stringify(errors, null, 1)}`);
  });

  test("parseBlueprint takes the JSON out of an answer, and says when it's cut off", () => {
    assert.equal(parseBlueprint('Here it is:\n```json\n{"name": "x", "files": []}\n```').data.name, 'x');
    assert.match(parseBlueprint('{"name": "x", "files": [{"path": "a.js"').error, /cut off/);
    assert.match(parseBlueprint('I cannot help with that.').error, /no JSON object/);
  });

  test('imports resolve like the bundlers do: extensions, index files, Vite root paths, .js for .ts, nothing outside', () => {
    const paths = new Set(['src/App.jsx', 'src/lib/index.js', 'src/util.ts', 'client/src/main.jsx', 'client/index.html', 'src/styles.css']);
    const roots = ['', 'client'];
    assert.equal(resolveImport('src/main.jsx', './App', paths, roots), 'src/App.jsx');
    assert.equal(resolveImport('src/main.jsx', './lib', paths, roots), 'src/lib/index.js');
    assert.equal(resolveImport('src/main.jsx', './util.js', paths, roots), 'src/util.ts');
    assert.equal(resolveImport('src/main.jsx', './styles.css?inline', paths, roots), 'src/styles.css');
    assert.equal(resolveImport('client/index.html', '/src/main.jsx', paths, roots), 'client/src/main.jsx', 'a leading / is the root of its own package');
    assert.equal(resolveImport('src/main.jsx', '../../etc/passwd', paths, roots), null);
    assert.equal(resolveImport('src/main.jsx', './Missing.jsx', paths, roots), null);
    assert.deepEqual(
      ['react-dom/client', '@react-three/fiber/native', 'three/examples/jsm/controls/OrbitControls.js', 'node:fs', 'path'].map((item) => [packageOf(item).name, packageOf(item).builtin]),
      [['react-dom', false], ['@react-three/fiber', false], ['three', false], ['node:fs', true], ['path', true]],
    );
  });
});

describe('The QA compiler (deterministic checks)', () => {
  const good = () =>
    new Map([
      ...manifestFiles(valid()).map((item) => [item.path, item.content]),
      ['index.html', '<!doctype html>\n<html><body><input placeholder="Search tasks"><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n'],
      ['src/main.jsx', "import { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\n\ncreateRoot(document.getElementById('root')).render(<App />);\n"],
      ['src/App.jsx', "import { useEffect, useState } from 'react';\nimport { fetchTasks } from './api.js';\n\nexport default function App() {\n  const [tasks, setTasks] = useState([]);\n  useEffect(() => { fetchTasks().then(setTasks); }, []);\n  if (typeof window.__DEBUG__ !== 'undefined') console.info(tasks.length);\n  return <ul className=\"tasks\">{tasks.map((task) => <li key={task.id}>{task.title}</li>)}</ul>;\n}\n"],
      ['src/api.js', "// Loads the rest of the tasks page by page.\nexport async function fetchTasks() {\n  const response = await fetch('/api/tasks');\n  if (!response.ok) throw new Error(`HTTP ${response.status}`);\n  return response.json();\n}\n"],
      ['server/index.js', "import express from 'express';\nimport path from 'node:path';\nimport fs from 'fs';\n\nconst app = express();\napp.get('/api/tasks', (req, res) => res.json(JSON.parse(fs.readFileSync(path.resolve('tasks.json'), 'utf8'))));\napp.listen(process.env.PORT ?? 3000);\n"],
    ]);

  test('a correct project passes: HTML placeholder attributes, typeof guards, globals and ordinary comments are not errors', () => {
    const { issues, missingPackages, dependents } = checkProject(good(), valid());
    assert.deepEqual(Object.fromEntries(issues), {});
    assert.equal(missingPackages.size, 0);
    assert.deepEqual([...dependents.get('src/api.js')], ['src/App.jsx']);
    assert.deepEqual([...dependents.get('src/main.jsx')], ['index.html']);
  });

  test('it finds syntax errors, missing files and exports, undeclared packages, undefined names and placeholders, on the file that must change', () => {
    const files = good();
    files.set('src/main.jsx', "import { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\nimport Header from './Header.jsx';\n\ncreateRoot(document.getElementById('root')).render(<><Header /><App /></>);\n");
    files.set('src/App.jsx', "import { useState } from 'react';\nimport { fetchTask } from './api.js';\n\nexport default function App() {\n  const [tasks] = useState([]);\n  // TODO: add logic here\n  return <ul>{items.map((item) => <Row key={item.id} />)}</ul>;\n}\n");
    files.set('src/api.js', "export async function getTasks() {\n  throw new Error('Not implemented');\n}\n");
    files.set('server/index.js', "import express from 'express';\nimport cors from 'cors';\nconst app = express(;\n");
    files.set('src/data.json', '{ "a": 1, }');
    files.set('src/app.css', '.tasks { color: red;\n/* rest of the styles */\n');
    files.delete('index.html');
    const blueprint = valid();
    blueprint.files.push({ path: 'src/data.json', exports: [], imports: [], spec: '' }, { path: 'src/app.css', exports: [], imports: [], spec: '' });
    const { issues, missingPackages } = checkProject(files, blueprint);
    const of = (file) => (issues.get(file) ?? []).map((issue) => `${issue.kind}${issue.line ? `@${issue.line}` : ''}: ${issue.message}`);
    assert.deepEqual(of('src/main.jsx'), ['import@3: Imports "./Header.jsx", but no such file is in the project.']);
    const app = of('src/App.jsx');
    assert.ok(app.includes('import@2: Imports "fetchTask" from "./api.js", but src/api.js doesn\'t export it (it exports: getTasks).'), app.join('\n'));
    assert.ok(app.includes('undefined@7: "items" is used but never defined or imported.'), app.join('\n'));
    assert.ok(app.includes('undefined@7: "Row" is used but never defined or imported.'), 'an unknown component');
    assert.ok(app.some((line) => /^placeholder@6: Placeholder comment "TODO: add logic here"/.test(line)), app.join('\n'));
    const api = of('src/api.js');
    assert.ok(api.some((line) => /^placeholder@2: Throws "Not implemented"/.test(line)), api.join('\n'));
    assert.ok(api.includes('contract: Must export "fetchTasks" (fetchTasks(): Promise<Task[]>) as the blueprint says, but doesn\'t.'), api.join('\n'));
    assert.match(of('server/index.js')[0], /^syntax@3: Syntax error: Unexpected token/);
    assert.equal(missingPackages.size, 0, "a file that doesn't parse has no imports to judge yet");
    assert.match(of('src/data.json')[0], /^syntax: Invalid JSON/);
    assert.deepEqual(of('src/app.css').sort(), ['placeholder@2: Placeholder comment "rest of the styles": write the real styles.', 'syntax: 1 "{" never closed.']);
    assert.deepEqual(of('index.html'), ['missing: The file was never written.']);

    files.set('server/index.js', "import express from 'express';\nimport cors from 'cors';\nexport const app = express().use(cors());\n");
    assert.deepEqual([...checkProject(files, blueprint).missingPackages.get('package.json')], ['cors'], 'an undeclared package is collected for its package.json');
  });

  test('test globals only count in test files; TypeScript parses without judging its types', () => {
    const blueprint = valid();
    const files = new Map([
      ['src/sum.test.js', "import { sum } from './sum.js';\ndescribe('sum', () => { it('adds', () => expect(sum(1, 2)).toBe(3)); });\n"],
      ['src/sum.js', "export const sum = (a, b) => a + b;\ndescribe('not here');\n"],
      ['src/types.ts', 'export interface Task { id: string }\nexport function first<T>(items: T[]): T | undefined { return items[0]; }\n'],
    ]);
    const { issues } = checkProject(files, { ...blueprint, files: [] });
    assert.equal(issues.get('src/sum.test.js'), undefined);
    assert.deepEqual(issues.get('src/sum.js').map((issue) => issue.message), ['"describe" is used but never defined or imported.']);
    assert.equal(issues.get('src/types.ts'), undefined);
  });

  test('placeholder words: the lazy phrases, not a to-do app or a spread', () => {
    for (const text of ['TODO: wire this up', 'FIXME', 'Add your logic here', 'implementation goes here', '... rest of the code', 'rest of the component', 'Not implemented yet', 'simplified version for brevity', '...']) assert.ok(placeholderIn(text), text);
    for (const text of ['Render the todo items', 'The rest of the tasks load lazily', 'input placeholder color', 'Spread the defaults: ...defaults']) assert.ok(!placeholderIn(text), text);
  });
});

describe('The micro-agents', () => {
  test('stripFence takes the code out of a fenced answer, and leaves a README with its own fences alone', () => {
    assert.equal(stripFence('```js\nexport const a = 1;\n```'), 'export const a = 1;');
    assert.equal(stripFence('Here is the file:\n\n```jsx\nexport default function A() {}\n```\nDone.'), 'export default function A() {}');
    const readme = '# App\n\n```bash\nnpm install\n```\n';
    assert.equal(stripFence(readme), readme.trim());
    assert.equal(fenceFor('no fences'), '```');
    assert.equal(fenceFor('has ``` and ````'), '`````');
  });

  test("an agent's brief: the contracts, the packages it may use, the interfaces it imports, and who imports it", () => {
    const blueprint = valid();
    const brief = fileBrief(blueprint, blueprint.files.find((file) => file.path === 'src/App.jsx'));
    assert.match(brief, /# Shared contracts\nGET \/api\/tasks/);
    assert.match(brief, /# Packages this file may import\nexpress@\^5\.1\.0, react@\^19\.1\.0, react-dom@\^19\.1\.0, vite@\^7\.1\.0/);
    assert.match(brief, /## "\.\/api\.js" is src\/api\.js\nThe API client\nExports:\n {2}- fetchTasks \(function\): fetchTasks\(\): Promise<Task\[\]>/);
    assert.match(brief, /# Files that import this one \(keep what they use working\)\n- src\/main\.jsx imports default/);
    assert.match(brief, /# The file to write: src\/App\.jsx\nLanguage: jsx/);
  });

  test('pool: never more than the limit at a time, every item done, and nothing new after an abort', async () => {
    let running = 0;
    let most = 0;
    const done = [];
    await pool([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      done.push(item);
    });
    assert.equal(most, 3);
    assert.deepEqual(done.sort(), [1, 2, 3, 4, 5, 6, 7]);
    const controller = new AbortController();
    const started = [];
    await pool([1, 2, 3, 4, 5], 2, async (item) => {
      started.push(item);
      if (item === 2) controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }, controller.signal);
    assert.deepEqual(started, [1, 2]);
  });
});
