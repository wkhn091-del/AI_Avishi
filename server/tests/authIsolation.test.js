// Accounts and privacy: what a request needs to be let in (Supabase tokens by public key, legacy tokens
// confirmed by Supabase Auth, the read-only session cookie, the admin gate), and that one person's
// conversations, files, ZIPs, usage and memories never reach another, in the API or in what the models
// and the learner are shown.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { MEMBER, OWNER, rawFetch, startTestDatabase, tempDir, tokenFor } from './helpers.js';

// A stand-in for the Supabase project: its public keys, and Auth's /user for legacy (HS256) tokens.
const LEGACY_SECRET = 'legacy-project-secret-for-the-stand-in-only';
const signing = await generateKeyPair('ES256', { extractable: true });
const stranger = await generateKeyPair('ES256');
const jwks = { keys: [{ ...(await exportJWK(signing.publicKey)), kid: 'project-key', alg: 'ES256', use: 'sig' }] };
const hits = { jwks: 0, user: 0 };
const project = http.createServer((req, res) => {
  if (req.url === '/auth/v1/.well-known/jwks.json') {
    hits.jwks += 1;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(jwks));
  } else if (req.url === '/auth/v1/user') {
    hits.user += 1;
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const [header, payload, signature] = token.split('.');
    const valid = signature && signature === Buffer.from(require_hmac(`${header}.${payload}`)).toString('base64url');
    if (!valid || req.headers.apikey !== process.env.SUPABASE_PUBLISHABLE_KEY) return res.writeHead(401).end('{}');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: claims.sub, email: claims.email, user_metadata: {}, is_anonymous: false }));
  } else res.writeHead(404).end();
});
const { createHmac } = await import('node:crypto');
function require_hmac(text) {
  return createHmac('sha256', LEGACY_SECRET).update(text).digest();
}
await new Promise((resolve) => project.listen(0, '127.0.0.1', resolve));
const SUPABASE = `http://127.0.0.1:${project.address().port}`;

// This suite's project uses asymmetric keys: no shared secret on the server.
process.env.SUPABASE_URL = SUPABASE;
delete process.env.SUPABASE_JWT_SECRET;
const storage = await tempDir('stash-auth-');
process.env.STORAGE_DIR = storage.dir;
process.env.LOG_REQUESTS = 'false';
process.env.ANTHROPIC_API_KEY = 'anthropic-key';
process.env.OPENAI_API_KEY = 'openai-key';
process.env.MEMORY_EMBEDDINGS = 'off';
for (const name of ['AI_PROVIDER', 'AI_PROVIDERS', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'TAVILY_API_KEY', 'MOONSHOT_API_KEY', 'LONG_TERM_MEMORY', 'CHAT_HANDOFF']) delete process.env[name];

/** A token signed by the project's key (or another one), with claims to break for the tests. */
function projectToken(user, { issuer = `${SUPABASE}/auth/v1`, audience = 'authenticated', expires = '1h', claims = {}, key = signing.privateKey, kid = 'project-key' } = {}) {
  return new SignJWT({ email: user.email, role: 'authenticated', ...claims }).setProtectedHeader({ alg: 'ES256', kid }).setSubject(user.id).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(expires).sign(key);
}
const as = async (user) => ({ authorization: `Bearer ${await projectToken(user)}` });

// The models: an answer with two files (so a ZIP is made), and the learner. Their instructions are kept.
const seen = [];
const CODE = 'הנה הקוד:\n\n```js src/a.js\nexport const a = 1;\n```\n\n```js src/b.js\nexport const b = 2;\n```\n';
let learned = { memories: [] };
const appFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null;
  if (href === 'https://api.anthropic.com/v1/messages') {
    seen.push({ to: 'answer', system: typeof body.system === 'string' ? body.system : JSON.stringify(body.system) });
    const events = [
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: CODE } })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 300, output_tokens: 60 } })}`,
    ];
    return new Response(events.map((event) => `${event}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }
  if (href === 'https://api.openai.com/v1/chat/completions') {
    seen.push({ to: 'learner', prompt: JSON.stringify(body.messages) });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(learned) }, finish_reason: 'stop' }], usage: { prompt_tokens: 500, completion_tokens: 40 } }), { headers: { 'content-type': 'application/json' } });
  }
  return appFetch(url, init);
};

const database = await startTestDatabase();
const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
console.warn = () => {};
console.log = () => {};

let server;
let base;
let store;
before(async () => {
  await Promise.all([config.paths.archives, config.paths.files].map((dir) => fs.mkdir(dir, { recursive: true })));
  store = new JsonStore(config.paths.database);
  await store.init();
  server = createApp({ store }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await store.flush();
  await storage.cleanup();
  await new Promise((resolve) => project.close(resolve));
});

/** A request as nobody (headers: none) or with the given headers. */
const call = (route, { method = 'GET', headers = {}, body } = {}) =>
  rawFetch(`${base}${route}`, { method, headers: { ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...headers }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
const json = async (response) => ({ status: response.status, body: await response.json().catch(() => null) });
async function turn(headers, chatId, content, extra = {}) {
  const response = await call(`/chat/conversations/${chatId}/messages`, { method: 'POST', headers, body: { workspace: 'premium', premiumModel: 'haiku-4.5', effort: 'low', content, ...extra } });
  if (response.status !== 200) return { status: response.status, body: await response.json() };
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  return { status: 200, events, final: events.find((event) => event.type === 'done' || event.type === 'error'), bundle: events.find((event) => event.type === 'bundle')?.bundle };
}
async function waitFor(check, ms = 3_000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error('Timed out waiting for the background work.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('Accounts and privacy', () => {
  test('without a valid sign-in, only health and the sign-in settings answer', async () => {
    assert.equal((await call('/health')).status, 200);
    const settings = await json(await call('/auth/config'));
    assert.deepEqual(settings.body, { configured: true, supabaseUrl: SUPABASE, publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY });
    for (const [method, route] of [['GET', '/chat/conversations'], ['POST', '/memory'], ['GET', '/media'], ['GET', '/auth/me']]) {
      const { status, body } = await json(await call(route, { method }));
      assert.deepEqual([status, body.error.code], [401, 'UNAUTHENTICATED'], `${method} ${route}`);
    }
    const broken = {
      'not a token': 'abc.def.ghi',
      expired: await projectToken(OWNER, { expires: Math.floor(Date.now() / 1000) - 60 }),
      'another issuer': await projectToken(OWNER, { issuer: 'https://someone-else.supabase.co/auth/v1' }),
      'another audience': await projectToken(OWNER, { audience: 'service' }),
      'signed by a stranger': await projectToken(OWNER, { key: stranger.privateKey }),
      anonymous: await projectToken(OWNER, { claims: { is_anonymous: true } }),
    };
    for (const [name, token] of Object.entries(broken)) {
      const { status, body } = await json(await call('/auth/me', { headers: { authorization: `Bearer ${token}` } }));
      assert.equal(status, 401, name);
      assert.equal(body.error.code, name === 'expired' ? 'SESSION_EXPIRED' : 'UNAUTHENTICATED', name);
    }
  });

  test("tokens are checked against the project's public keys; a legacy token is confirmed by Supabase Auth, once a minute", async () => {
    const me = await json(await call('/auth/me', { headers: await as(OWNER) }));
    assert.deepEqual([me.status, me.body.user.email, me.body.user.isAdmin, me.body.user.plan], [200, OWNER.email, true, 'free']);
    assert.equal(hits.jwks, 1, 'the public keys were fetched once');
    await call('/auth/me', { headers: await as(MEMBER) });
    assert.equal(hits.jwks, 1, 'and kept');
    const legacy = tokenFor(MEMBER, { secret: LEGACY_SECRET });
    for (let round = 0; round < 2; round += 1) {
      const answer = await json(await call('/auth/me', { headers: { authorization: `Bearer ${legacy}` } }));
      assert.deepEqual([answer.status, answer.body.user.email, answer.body.user.isAdmin], [200, MEMBER.email, false]);
    }
    assert.equal(hits.user, 1, 'Supabase Auth was asked once, then its answer was kept');
    const forged = tokenFor(MEMBER, { secret: 'not-the-project-secret' });
    assert.equal((await call('/auth/me', { headers: { authorization: `Bearer ${forged}` } })).status, 401);
  });

  test('the session cookie lets media and downloads load, and never changes anything', async () => {
    const set = await call('/auth/session', { method: 'POST', headers: await as(OWNER) });
    assert.equal(set.status, 204);
    const cookie = set.headers.get('set-cookie');
    assert.match(cookie, /^stash_session=[^;]+; Max-Age=\d+; Path=\/api; Expires=[^;]+; HttpOnly; SameSite=Lax$/);
    const session = cookie.split(';')[0];
    assert.equal((await call('/chat/conversations', { headers: { cookie: session } })).status, 200, 'reading with the cookie');
    const write = await json(await call('/chat/conversations', { method: 'POST', headers: { cookie: session }, body: {} }));
    assert.deepEqual([write.status, write.body.error.code], [401, 'UNAUTHENTICATED'], 'writing needs the header');
    const cleared = await call('/auth/session', { method: 'DELETE' });
    assert.match(cleared.headers.get('set-cookie'), /^stash_session=; Path=\/api; Expires=Thu, 01 Jan 1970/);
  });

  test('the tools with one shared store are for admins only', async () => {
    for (const route of ['/projects', '/github/status', '/links', '/files']) {
      const { status, body } = await json(await call(route, { headers: await as(MEMBER) }));
      assert.deepEqual([status, body?.error?.code], [403, 'ADMIN_ONLY'], route);
    }
    assert.equal((await call('/projects', { headers: await as(OWNER) })).status, 200);
  });

  test("one person's conversations, attachments, ZIPs and usage don't exist for another", async () => {
    const owner = await as(OWNER);
    const member = await as(MEMBER);
    const chat = (await json(await call('/chat/conversations', { method: 'POST', headers: owner, body: {} }))).body.conversation.id;
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'shot.png');
    const attachment = (await json(await call('/chat/attachments', { method: 'POST', headers: owner, body: form }))).body.attachment;
    const answered = await turn(owner, chat, 'כתוב שני קבצים', { attachments: [attachment.id] });
    assert.equal(answered.final.type, 'done');
    assert.ok(answered.bundle, 'the answer made a ZIP');

    // To the other person, all of it is missing.
    assert.deepEqual((await json(await call('/chat/conversations', { headers: member }))).body.conversations, []);
    for (const [method, route, body] of [
      ['GET', `/chat/conversations/${chat}`],
      ['GET', `/chat/conversations/${chat}/usage`],
      ['GET', `/chat/conversations/${chat}/memory`],
      ['PATCH', `/chat/conversations/${chat}`, { title: 'שלי עכשיו' }],
      ['DELETE', `/chat/conversations/${chat}`],
      ['GET', `/chat/attachments/${attachment.id}`],
      ['GET', `/chat/bundles/${answered.bundle.id}`],
    ]) {
      assert.equal((await call(route, { method, headers: member, body })).status, 404, `${method} ${route}`);
    }
    assert.equal((await turn(member, chat, 'שלום')).status, 404, 'writing into it');
    await call(`/chat/attachments/${attachment.id}`, { method: 'DELETE', headers: member });
    assert.equal((await call(`/chat/attachments/${attachment.id}`, { headers: owner })).status, 200, "the other person can't delete it either");
    // Their own conversation can't use the first person's attachment, and their totals count only theirs.
    const theirs = (await json(await call('/chat/conversations', { method: 'POST', headers: member, body: {} }))).body.conversation.id;
    const borrowed = await turn(member, theirs, 'תראה את התמונה', { attachments: [attachment.id] });
    assert.deepEqual([borrowed.status, borrowed.body.error.code], [400, 'ATTACHMENT_NOT_FOUND']);
    assert.equal((await turn(member, theirs, 'שלום')).final.type, 'done');
    const usage = (await json(await call(`/chat/conversations/${theirs}/usage`, { headers: member }))).body;
    assert.equal(usage.all.conversations, 1);
    // And in the database, every conversation row carries its owner.
    const rows = (await database.pglite.query('SELECT id, user_id FROM chat_sessions ORDER BY created_at')).rows;
    assert.deepEqual(rows, [{ id: chat, user_id: OWNER.id }, { id: theirs, user_id: MEMBER.id }]);
    // The owner still has everything.
    assert.equal((await call(`/chat/bundles/${answered.bundle.id}`, { headers: owner })).status, 200);
    assert.equal((await json(await call(`/chat/conversations/${chat}`, { headers: owner }))).body.conversation.messageCount, 2);
  });

  test('memories are each person\'s own: in the API, in what the models are given, and in what is learned', async () => {
    const owner = await as(OWNER);
    const member = await as(MEMBER);
    const mine = (await json(await call('/memory', { method: 'POST', headers: owner, body: { content: 'מעדיף תשובות קצרות', kind: 'preference' } }))).body.memory;
    assert.deepEqual((await json(await call('/memory', { headers: member }))).body.memories, []);
    assert.equal((await call(`/memory/${mine.id}`, { method: 'PATCH', headers: member, body: { content: 'שונה' } })).status, 404);
    assert.equal((await call(`/memory/${mine.id}`, { method: 'DELETE', headers: member })).status, 404);
    assert.deepEqual((await json(await call('/memory', { method: 'DELETE', headers: member }))).body, { removed: 0 });
    assert.equal((await json(await call('/memory', { headers: owner }))).body.memories.length, 1, 'still there');

    // The other person's answer isn't given the first person's memories; the first person's is.
    const theirs = (await json(await call('/chat/conversations', { method: 'POST', headers: member, body: {} }))).body.conversation.id;
    learned = { memories: [{ content: 'משתמש ב-pnpm ולא ב-npm', kind: 'preference', project: null, replaces: null }] };
    let from = seen.length;
    await turn(member, theirs, 'אני עובד עם pnpm');
    const answerFor = (list) => list.find((item) => item.to === 'answer');
    assert.ok(!answerFor(seen.slice(from)).system.includes('מעדיף תשובות קצרות'), "another person's memory never reaches the model");
    // What they taught is theirs alone, and the learner never saw the first person's memories.
    const learnedByThem = await waitFor(async () => (await json(await call('/memory', { headers: member }))).body.memories.find((item) => item.content.includes('pnpm')));
    const learnerCall = seen.slice(from).find((item) => item.to === 'learner');
    assert.ok(learnerCall && !learnerCall.prompt.includes('מעדיף תשובות קצרות') && !learnerCall.prompt.includes(mine.id));
    learned = { memories: [] };
    assert.ok(!(await json(await call('/memory', { headers: owner }))).body.memories.some((item) => item.content.includes('pnpm')));
    const [row] = (await database.pglite.query('SELECT user_id, chat_session_id FROM memories WHERE id = $1', [learnedByThem.id])).rows;
    assert.deepEqual(row, { user_id: MEMBER.id, chat_session_id: theirs });

    from = seen.length;
    const chat = (await json(await call('/chat/conversations', { method: 'POST', headers: owner, body: {} }))).body.conversation.id;
    await turn(owner, chat, 'שאלה');
    const system = answerFor(seen.slice(from)).system;
    assert.ok(system.includes('מעדיף תשובות קצרות') && !system.includes('pnpm'), 'each answer gets its own person\'s memories');
  });
});

after(() => database.stop());
