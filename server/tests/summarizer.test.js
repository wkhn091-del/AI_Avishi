// The AI prompt and the checks applied to the model's answer (no network needed).
process.env.AI_PROVIDER = 'none';
process.env.LOG_REQUESTS = 'false';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { makeZip, tempDir } from './helpers.js';

const { HEBREW_RULE, SYSTEM_PROMPT, buildPrompt, mergeTags, validateAnswer } = await import('../src/services/projects/summarizer.js');
const { scanArchive } = await import('../src/services/projects/archiveScanner.js');
const { deriveInsights } = await import('../src/services/projects/insights.js');

let dir;
let cleanup;
before(async () => ({ dir, cleanup } = await tempDir()));
after(() => cleanup());

describe('AI prompt', () => {
  test('the system prompt requires Hebrew', () => {
    assert.equal(HEBREW_RULE, 'You must generate the project title, tags, and description entirely in Hebrew.');
    assert.ok(SYSTEM_PROMPT.includes(HEBREW_RULE));
  });

  test('every request ends with a reminder to answer in Hebrew', async () => {
    const file = await makeZip(dir, 'weather.zip', { 'README.md': '# Weather Now\n\nHourly forecasts for any city.\n', 'index.js': '' });
    const scan = scanArchive(file, { archiveName: 'weather.zip' });
    const lastLine = buildPrompt(scan, deriveInsights(scan)).trim().split('\n').at(-1);
    assert.match(lastLine, /Hebrew/);
  });
});

describe('AI answers', () => {
  test('accepts a Hebrew answer and drops tags without Hebrew letters', () => {
    const answer = validateAnswer({
      title: 'מזג אוויר עכשיו',
      description: 'תחזית שעתית ושבועית לכל עיר, עם התראות על גשם.',
      tags: ['מזג אוויר', 'React', 'תחזית'],
    });
    assert.equal(answer.title, 'מזג אוויר עכשיו');
    assert.deepEqual(answer.tags, ['מזג אוויר', 'תחזית']);
  });

  test('rejects answers that are not in Hebrew or are incomplete', () => {
    assert.throws(() => validateAnswer({ title: 'Weather Now', description: 'Hourly forecasts.', tags: [] }), { name: 'AiError' });
    assert.throws(() => validateAnswer({ title: 'מזג אוויר' }), { name: 'AiError' });
  });

  test('detected technology tags come first, duplicates are removed', () => {
    assert.deepEqual(mergeTags(['React', 'Vite'], ['משחק', 'react']), ['React', 'Vite', 'משחק']);
  });
});
