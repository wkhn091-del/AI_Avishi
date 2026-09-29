// ZIP analysis: scanning, detection and the built-in (non-AI) summary.
process.env.AI_PROVIDER = 'none';
process.env.LOG_REQUESTS = 'false';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { makeZip, tempDir } from './helpers.js';

const { analyzeArchive } = await import('../src/services/projects/analyzeArchive.js');

let dir;
let cleanup;
before(async () => ({ dir, cleanup } = await tempDir()));
after(() => cleanup());

const analyze = async (name, entries, options) => analyzeArchive(await makeZip(dir, name, entries, options), { archiveName: name });
const json = (value) => JSON.stringify(value);
const HEBREW = /[\u05D0-\u05EA]/;

describe('scanning', () => {
  test('unwraps a single top-level folder and skips dependency and system files', async () => {
    const project = await analyze('weather-app-main.zip', {
      'weather-app-main/README.md': '# Weather Now\n\nHourly forecasts for any city, with rain alerts.\n',
      'weather-app-main/package.json': json({ dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^7.0.0' } }),
      'weather-app-main/src/App.jsx': 'export default function App() {}',
      'weather-app-main/node_modules/react/index.js': 'module.exports = {}',
      'weather-app-main/.DS_Store': 'x',
      '__MACOSX/weather-app-main/._README.md': 'x',
    });
    assert.equal(project.title, 'Weather Now');
    assert.equal(project.description, 'Hourly forecasts for any city, with rain alerts.');
    assert.deepEqual(project.topLevel.map((item) => item.name).sort(), ['README.md', 'package.json', 'src']);
    assert.equal(project.stats.fileCount, 3);
    assert.equal(project.stats.ignoredEntries, 3);
    assert.equal(project.kind, 'web');
    assert.ok(project.techStack.includes('React') && project.techStack.includes('Vite'));
    assert.equal(project.summary.source, 'heuristic');
  });

  test('drops entries that try to escape the archive (zip-slip)', async () => {
    const project = await analyze(
      'site.zip',
      { 'index.html': '<title>Portfolio</title>', 'aa/aa/evil.txt': 'owned' },
      { rename: { 'aa/aa/evil.txt': '../../evil.txt' } },
    );
    assert.equal(project.stats.fileCount, 1);
    assert.ok(project.topLevel.every((item) => !item.name.includes('..')));
  });

  test('rejects a damaged archive with a 422', async () => {
    const file = path.join(dir, 'broken.zip');
    await fs.writeFile(file, 'this is not a zip file');
    await assert.rejects(analyzeArchive(file, { archiveName: 'broken.zip' }), { status: 422, code: 'INVALID_ZIP' });
  });

  test('handles an empty archive', async () => {
    const project = await analyze('empty.zip', {});
    assert.equal(project.stats.fileCount, 0);
    assert.equal(project.fingerprint.length, 0);
    assert.ok(project.title);
    assert.match(project.description, HEBREW);
  });
});

describe('titles and descriptions', () => {
  test('skips a template README and uses the page title instead', async () => {
    const project = await analyze('app.zip', {
      'README.md': '# React + Vite\n\nThis template provides a minimal setup to get React working in Vite with HMR.\n',
      'index.html': '<html><head><title>Harbor Weather | Marine forecasts</title></head></html>',
      'package.json': json({ name: 'app', dependencies: { react: '19' } }),
    });
    assert.equal(project.title, 'Harbor Weather');
  });

  test('keeps Hebrew titles and descriptions intact', async () => {
    const project = await analyze('מתכונים.zip', {
      'README.md': '# מתכונים של סבתא\n\nאתר מתכונים משפחתי עם חיפוש לפי מצרכים.\n',
      'app/page.tsx': 'export default function Page() {}',
    });
    assert.equal(project.title, 'מתכונים של סבתא');
    assert.equal(project.description, 'אתר מתכונים משפחתי עם חיפוש לפי מצרכים.');
  });

  test('writes a Hebrew description when the project has none', async () => {
    const project = await analyze('app.zip', {
      'package.json': json({ dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^7.0.0' } }),
      'src/App.tsx': 'export default function App() {}',
    });
    assert.match(project.description, HEBREW);
    assert.ok(project.description.includes('React') && project.description.includes('TypeScript'), project.description);
  });

  test('falls back to a readable version of the archive name', async () => {
    for (const name of ['space-miner-main (1).zip', 'space_miner_v1.4.2.zip', 'SpaceMiner.zip']) {
      const project = await analyze(name, { 'main.py': 'print(1)' });
      assert.equal(project.title, 'Space Miner', name);
    }
  });
});

describe('kind detection', () => {
  const cases = [
    ['Unity game', 'game', { 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.0.23f1', 'Assets/Scripts/Player.cs': 'class Player {}' }],
    ['ML project with an inference API', 'ml', { 'requirements.txt': 'torch\ntransformers\nfastapi\n', 'src/train.py': 'import torch' }],
    ['Telegram bot', 'bot', { 'package.json': json({ dependencies: { telegraf: '^4.16.0' } }), 'index.js': 'bot.launch()' }],
    ['Expo app', 'mobile', { 'package.json': json({ dependencies: { expo: '^53.0.0', 'react-native': '0.79.0' } }), 'App.tsx': 'export default App' }],
    ['Go CLI', 'cli', { 'go.mod': 'module example.com/trail\n\ngo 1.24\n', 'cmd/trail/main.go': 'package main' }],
    ['Tauri desktop app', 'desktop', { 'package.json': json({ dependencies: { '@tauri-apps/api': '^2.0.0', react: '^19.0.0' } }), 'src-tauri/src/main.rs': 'fn main() {}' }],
  ];
  for (const [label, kind, entries] of cases) {
    test(`${label} → ${kind}`, async () => {
      const project = await analyze(`${kind}.zip`, entries);
      assert.equal(project.kind, kind);
    });
  }

  test('Unity 6 is named by its product version', async () => {
    const project = await analyze('game.zip', { 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.0.23f1', 'Assets/A.cs': '' });
    assert.ok(project.techStack.includes('Unity 6'), project.techStack.join(', '));
  });

  test('finds Expo entry points', async () => {
    const project = await analyze('expo.zip', { 'package.json': json({ dependencies: { expo: '53' } }), 'App.tsx': '', 'src/util.ts': '' });
    assert.ok(project.entryPoints.includes('App.tsx'));
  });
});

describe('fingerprint', () => {
  test('one bar per file for small projects, capped at 64', async () => {
    const small = await analyze('small.zip', { 'a.ts': 'x', 'b.ts': 'y', 'README.md': '# Small' });
    assert.equal(small.fingerprint.length, 3);

    const entries = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`src/file${i}.ts`, 'export {}\n'.repeat(i + 1)]));
    const large = await analyze('large.zip', entries);
    assert.equal(large.fingerprint.length, 64);
    for (const [category, level] of large.fingerprint) {
      assert.equal(category, 'TypeScript');
      assert.ok(level >= 1 && level <= 10);
    }
  });
});
