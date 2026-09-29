// The browser app on another origin (a Vercel frontend with this API on Render): which origins CORS_ORIGINS lets in,
// the CORS headers and preflights, the cross-site guard, the read-only link tokens for what the browser loads itself,
// the logs (no tokens; for an error, the request, the route and the stack), and JSON where Express would say
// "Cannot GET /".
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { OWNER, authHeader, rawFetch, tempDir } from './helpers.js';

const storage = await tempDir('stash-cross-origin-');
Object.assign(process.env, {
  STORAGE_DIR: storage.dir,
  AI_PROVIDER: 'none',
  LOG_REQUESTS: 'true',
  ADMIN_EMAILS: OWNER.email,
  CORS_ORIGINS: 'https://stash.vercel.app, https://stash-*-avishi.vercel.app/, https://*.vercel.app, stash.vercel.app, https://a*.com',
  RESOURCE_TOKEN_SECRET: 'a-long-random-secret-for-the-tests-only-0123456789',
});
const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { trustedOrigin } = await import('../src/lib/origins.js');
const { issueResourceToken, readResourceToken, redactUrl } = await import('../src/lib/resourceTokens.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');

const APP = 'https://stash.vercel.app';
let server;
let base;
before(async () => {
  const store = new JsonStore(config.paths.database);
  await store.init();
  server = createApp({ store }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await storage.cleanup();
});
const call = (path, { method = 'GET', headers = {}, body } = {}) => rawFetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body) });
const quietly = async (run) => {
  const log = console.log;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  try {
    await run();
  } finally {
    console.log = log;
  }
  return lines;
};

describe('The browser app on another origin', () => {
  test('CORS_ORIGINS: exact origins and preview patterns; a whole-label * or a malformed origin is refused', () => {
    assert.deepEqual(config.corsOrigins, ['https://stash.vercel.app', 'https://stash-*-avishi.vercel.app']);
    assert.deepEqual(config.corsRejected, ['https://*.vercel.app', 'stash.vercel.app', 'https://a*.com']);
    const trusted = ['https://stash.vercel.app', 'https://STASH.vercel.app', 'https://stash-git-main-avishi.vercel.app', 'https://stash-q1w2e3-avishi.vercel.app'];
    const refused = ['https://evil.vercel.app', 'https://stash.vercel.app.evil.com', 'https://stash-x.y-avishi.vercel.app', 'http://stash.vercel.app', 'null', '', undefined];
    assert.deepEqual(trusted.map(trustedOrigin), trusted.map(() => true));
    assert.deepEqual(refused.map(trustedOrigin), refused.map(() => false));
  });

  test('a preflight from the app: the methods, the headers, cached ten minutes; any other origin gets no CORS headers', async () => {
    const preflight = (origin) => call('/api/projects', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    const ok = await preflight(APP);
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), APP);
    assert.equal(ok.headers.get('access-control-allow-methods'), 'GET, HEAD, POST, PUT, PATCH, DELETE');
    assert.equal(ok.headers.get('access-control-allow-headers'), 'authorization,content-type');
    assert.equal(ok.headers.get('access-control-max-age'), '600');
    assert.equal(ok.headers.get('access-control-allow-credentials'), null, 'no cookies across sites');
    const other = await preflight('https://evil.example');
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    const read = await call('/api/health', { headers: { origin: 'https://stash-git-main-avishi.vercel.app' } });
    assert.equal(read.headers.get('access-control-allow-origin'), 'https://stash-git-main-avishi.vercel.app');
    assert.match(read.headers.get('access-control-expose-headers'), /Content-Disposition, X-Request-Id/);
    assert.match((await call('/api/health', { headers: { origin: 'https://evil.example' } })).headers.get('vary') ?? '', /Origin/);
  });

  test("the cross-site guard lets the app's changes through, and still refuses any other site's", async () => {
    const create = (origin) => call('/api/links', { method: 'POST', headers: { ...authHeader(OWNER), origin, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: { url: 'https://example.com', title: 'x' } });
    const fromApp = await create(APP);
    assert.notEqual(fromApp.status, 403, await fromApp.clone().text());
    const fromElsewhere = await create('https://evil.example');
    assert.deepEqual([fromElsewhere.status, (await fromElsewhere.json()).error.code], [403, 'CROSS_SITE']);
  });

  test('link tokens: from the session only; they read, never write, never make more, and fail forged or expired', async () => {
    const issued = await (await call('/api/auth/resource-token', { headers: authHeader(OWNER) })).json();
    const hours = (Date.parse(issued.expiresAt) - Date.now()) / 3_600_000;
    assert.ok(hours > 11.9 && hours <= 12, String(hours));
    const access = encodeURIComponent(issued.token);
    const lines = await quietly(async () => assert.equal((await call(`/api/links?access=${access}`)).status, 200));
    assert.ok(lines.some((line) => line.startsWith('GET /api/links?access=… → 200')), lines.join('\n'));
    assert.ok(!lines.join('\n').includes(issued.token.slice(0, 20)), 'no token in the log');
    const write = await call(`/api/links?access=${access}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: { url: 'https://example.com' } });
    assert.deepEqual([write.status, (await write.json()).error.code], [401, 'UNAUTHENTICATED']);
    const more = await call(`/api/auth/resource-token?access=${access}`);
    assert.deepEqual([more.status, (await more.json()).error.code], [403, 'BEARER_REQUIRED']);
    const forged = `${issued.token.split('.')[0]}.${'A'.repeat(43)}`;
    const refused = await call(`/api/links?access=${encodeURIComponent(forged)}`);
    assert.deepEqual([refused.status, (await refused.json()).error.code], [401, 'LINK_EXPIRED']);
    const old = issueResourceToken({ id: OWNER.id, email: OWNER.email }, Date.now() - 13 * 3_600_000);
    assert.equal(readResourceToken(old.token), null);
    assert.deepEqual(readResourceToken(issued.token), { id: OWNER.id, email: OWNER.email, name: null, avatarUrl: null });
    assert.equal(redactUrl('/api/media/1/file?download=1&access=abc.def'), '/api/media/1/file?download=1&access=…');
  });

  test('an unexpected error: in the log the request, its route, who asked and the stack; in the answer a request id and no internals', () => {
    const error = console.error;
    const lines = [];
    console.error = (...args) => lines.push(args);
    try {
      const headers = {};
      const res = { headersSent: false, set(name, value) { headers[name] = value; return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      const req = { method: 'POST', originalUrl: '/api/chat/conversations/7/messages?access=secret', baseUrl: '/api/chat', route: { path: '/conversations/:id/messages' }, user: { id: 'user-1' }, get: (name) => ({ origin: APP, 'x-request-id': 'rndr-42' })[name] };
      errorHandler(new TypeError("Cannot read properties of undefined (reading 'id')"), req, res, () => {});
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.body, { error: { message: 'אירעה שגיאה לא צפויה בשרת. הפרטים ביומן של השרת, תחת המזהה rndr-42.', code: 'INTERNAL', requestId: 'rndr-42' } });
      assert.equal(headers['X-Request-Id'], 'rndr-42');
      assert.equal(lines.length, 1);
      assert.equal(lines[0][0], `[error] rndr-42 POST /api/chat/conversations/7/messages?access=… → 500 (route: /api/chat/conversations/:id/messages; user: user-1; origin: ${APP})\n`);
      assert.match(lines[0][1].stack, /^TypeError: Cannot read properties of undefined/);
    } finally {
      console.error = error;
    }
  });

  test('without the browser app here, the root says what this is, and any other path is a JSON 404', async () => {
    assert.deepEqual(await (await call('/')).json(), { name: 'Stash API', health: '/api/health' });
    const missing = await call('/login');
    assert.deepEqual([missing.status, (await missing.json()).error.code], [404, 'NOT_FOUND']);
  });
});
