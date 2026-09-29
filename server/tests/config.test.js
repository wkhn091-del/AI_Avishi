// Safe .env loading: placeholder values are ignored, and AI_PROVIDERS limits the providers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';

process.env.AI_PROVIDERS = 'groq,openrouter,gemini';
process.env.GROQ_API_KEY = 'your_groq_key';
process.env.OPENROUTER_API_KEY = 'sk-or-real-key';
process.env.GEMINI_API_KEY = 'gemini-real-key';
process.env.ANTHROPIC_API_KEY = 'anthropic-real-key';
process.env.GITHUB_TOKEN = 'your_github_token';
delete process.env.AI_PROVIDER;

const { PLACEHOLDER_SETTINGS, config } = await import('../src/config.js');
const { getAiStatus, isConfigured } = await import('../src/services/ai/llmClient.js');

describe('Configuration', () => {
  test('values copied from .env.example are treated as unset and reported', () => {
    assert.equal(isConfigured('groq'), false);
    assert.equal(config.github.token, '');
    assert.ok(PLACEHOLDER_SETTINGS.includes('GROQ_API_KEY'));
    assert.ok(PLACEHOLDER_SETTINGS.includes('GITHUB_TOKEN'));
  });

  test('AI_PROVIDERS limits which providers are used, even when a key is set', () => {
    assert.equal(isConfigured('openrouter'), true);
    assert.equal(isConfigured('gemini'), true);
    assert.equal(isConfigured('anthropic'), false);
    assert.deepEqual(getAiStatus().providers.filter((provider) => provider.configured).map((provider) => provider.id), ['gemini', 'openrouter']);
  });

  test('an unknown provider in AI_PROVIDERS stops the server with a clear message', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config.js')"], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, AI_PROVIDERS: 'groq,skynet' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AI_PROVIDERS contains unknown providers: skynet/);
  });
});
