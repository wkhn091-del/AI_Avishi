/**
 * /api/chat: the AI workspace.
 *
 *   GET    /catalog                              the free and premium workspaces, the effort levels, memory settings
 *   GET    /conversations                        conversations, most recent first
 *   POST   /conversations                        start one
 *   GET    /conversations/:id                    one conversation, with its messages and memory
 *   PATCH  /conversations/:id        { title }   rename it
 *   DELETE /conversations/:id
 *   POST   /conversations/:id/messages           { content | regenerate, workspace: free|premium,
 *                                                  freeMode: manual|brainstorm|auto, provider, model,
 *                                                  premiumModel: auto|<catalog id>, emergency, effort }
 *          → JSON lines: start · context · route · research · recall · stage · team · retry · reasoning · expert · text · usage · bundle,
 *            then done or error, then memory when the conversation was compacted.
 *            Closing the request stops the answer; what was written so far is kept.
 *   GET    /conversations/:id/memory             project_state.md and compaction status (?download=1: the file)
 *   POST   /conversations/:id/memory/compact     compact now
 *   GET    /bundles/:id                          a packaged multi-file code answer (ZIP; rebuilt if it expired)
 *   GET    /runs/:id/events                      a development-team run, live: Server-Sent Events for its dashboard
 *   GET    /conversations/:id/artifacts/:aid     a generated project's files (?version=N; the latest by default) and its preview
 *   GET    /conversations/:id/artifacts/:aid/preview   its live preview: status, URL, when it ends
 *   POST   /conversations/:id/artifacts/:aid/preview   brings a preview that ended back (a new sandbox, npm install, the dev server)
 *   POST   /conversations/:id/media              record a picture, video or music made from the chat ({ kind, mediaId })
 *   POST   /attachments                          upload an image or a video for the next message (field "file")
 *   GET    /attachments/:id                      the file · DELETE removes an attachment that wasn't sent
 *   GET    /conversations/:id/usage              tokens and estimated cost: by model, by role, this month and all conversations
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { config } from '../config.js';
import { displayName } from '../lib/filenames.js';
import { HttpError } from '../lib/httpError.js';
import { acceptChatMedia } from '../middleware/uploads.js';
import { FREE_MODES, chatCatalog, effortOf, freeProviders, premiumModel, premiumProviders } from '../services/ai/catalog.js';
import { compactConversation, compactionDue, contextWindow, memoryInfo } from '../services/ai/compaction.js';
import { AiError, isConfigured } from '../services/ai/llmClient.js';
import { BASE_SYSTEM, runTurn } from '../services/ai/orchestrator.js';
import { providerById } from '../services/ai/providers.js';
import { attachmentPath, kindOf, loadMedia, publicAttachment } from '../services/chat/attachments.js';
import { extractCodeFiles, zipFiles } from '../services/chat/codeBundles.js';
import { callsOf, conversationCalls, conversationUsage, storedUsage, summarize, totalsOf, withCosts } from '../services/chat/usage.js';
import { PRICES_CHECKED } from '../services/ai/pricing.js';
import { createMeter, withTags } from '../services/ai/usageMeter.js';
import { learnFrom } from '../services/memory/learner.js';
import { chatSessions, listColumns } from '../services/chat/chatSessions.js';
import { ensureUser } from '../services/users.js';
import { CreditError, balanceOf, requireCredits, reserveCredits, unlimited } from '../services/credits.js';
import { findRun, subscribeRun } from '../services/ai/swarm/runs.js';
import { previewInfo, revivePreview } from '../services/ai/swarm/preview.js';
import { sandboxFor } from '../services/ai/swarm/sandbox/index.js';
import { artifactState } from '../services/chat/artifacts.js';
import { githubContextFor } from '../services/github/chatContext.js';

const MAX_MESSAGE_CHARS = 32_000;
const HISTORY_CHARS = 60_000;
const MAX_IMAGES = 5;
const HOUR = 3_600_000;
const MB = 1024 * 1024;
/** Generated media, as later models read it: "[<this> ב-Pollinations (model) לפי הבקשה: "…"]". */
const GENERATED = Object.freeze({ image: 'נוצרה תמונה', video: 'נוצר סרטון', music: 'נוצר קטע מוזיקה' });

/** The turn's settings, checked before the answer starts (so problems are plain 400s). */
export function validateTurn(body = {}) {
  const workspace = body.workspace === 'free' ? 'free' : 'premium';
  const request = {
    workspace,
    // A follow-up from a generated project's panel (the project's id): the team edits that project.
    artifact: typeof body.artifact?.id === 'string' && /^[\w-]{1,80}$/.test(body.artifact.id) ? body.artifact.id : null,
    freeMode: FREE_MODES.includes(body.freeMode) ? body.freeMode : 'auto',
    provider: typeof body.provider === 'string' ? body.provider : null,
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim().slice(0, 200) : null,
    premiumModel: body.premiumModel && body.premiumModel !== 'auto' && premiumModel(body.premiumModel) ? body.premiumModel : 'auto',
    emergency: workspace === 'premium' && body.emergency === true,
    effort: effortOf(body.effort).id,
    handoff: config.chat.handoff && body.handoff !== false,
    // The development team for complex coding requests (on unless the reader turned it off).
    pipeline: config.chat.pipeline.enabled && body.pipeline !== false,
    // Live web research when the router finds it's needed, and the long-term memory (both on unless turned off).
    research: config.research.enabled && body.research !== false,
    memory: config.longTermMemory.enabled && body.memory !== false,
  };
  if (workspace === 'premium' && premiumProviders().length === 0) {
    throw new HttpError(400, 'בסביבת הפרימיום אין ספק מוגדר. הוסיפו מפתח של Anthropic, OpenAI, Gemini, DeepSeek או Kimi בקובץ server/.env.', 'WORKSPACE_EMPTY');
  }
  if (workspace === 'free' && freeProviders().length === 0) {
    throw new HttpError(400, 'בסביבה החינמית אין ספק מוגדר. הוסיפו מפתח של Groq, OpenRouter, Cohere או Hugging Face בקובץ server/.env.', 'WORKSPACE_EMPTY');
  }
  if (request.emergency && !isConfigured('anthropic')) {
    throw new HttpError(400, 'מצב חירום דורש מפתח של Anthropic (ANTHROPIC_API_KEY).', 'EMERGENCY_UNAVAILABLE');
  }
  if (workspace === 'premium' && !request.emergency && request.premiumModel !== 'auto') {
    const entry = premiumModel(request.premiumModel);
    if (!isConfigured(entry.provider)) throw new HttpError(400, `המודל ${entry.label} דורש את המפתח ${providerById(entry.provider).keyEnv}.`, 'MODEL_UNAVAILABLE');
  }
  if (workspace === 'free' && request.freeMode === 'manual') {
    const provider = providerById(request.provider);
    if (!provider || provider.workspace !== 'free' || !isConfigured(provider.id)) {
      throw new HttpError(400, 'הספק שנבחר אינו מוגדר בסביבה החינמית. הוסיפו את המפתח שלו בקובץ server/.env.', 'PROVIDER_NOT_CONFIGURED');
    }
  }
  return request;
}

/** Attachments must suit the workspace and the model that will get them (checked before the answer starts). */
export function validateAttachments(request, records) {
  if (!records.length) return;
  const videos = records.filter((record) => record.kind === 'video').length;
  const noun = videos ? 'וידאו' : 'תמונות';
  if (request.workspace === 'free') throw new HttpError(400, 'צירוף תמונות ווידאו זמין בסביבת הפרימיום (Claude, GPT, Gemini, DeepSeek).', 'ATTACHMENTS_UNSUPPORTED');
  if (videos > 1) throw new HttpError(400, 'אפשר לצרף וידאו אחד בכל הודעה.', 'TOO_MANY_ATTACHMENTS');
  if (records.length - videos > MAX_IMAGES) throw new HttpError(400, `אפשר לצרף עד ${MAX_IMAGES} תמונות בכל הודעה.`, 'TOO_MANY_ATTACHMENTS');
  if (videos && !isConfigured('gemini')) throw new HttpError(400, 'וידאו נשלח רק ל-Gemini. הוסיפו GEMINI_API_KEY בקובץ server/.env.', 'VIDEO_UNAVAILABLE');
  if (request.emergency && videos) throw new HttpError(400, 'Fable 5.1 לא מקבל וידאו. כבו את מצב החירום, ו-Gemini ינתח את הסרטון.', 'ATTACHMENTS_UNSUPPORTED');
  const entry = !request.emergency && request.premiumModel !== 'auto' ? premiumModel(request.premiumModel) : null;
  if (entry && ((videos && !entry.video) || !entry.vision)) {
    throw new HttpError(400, `${entry.label} לא מקבל ${noun}. בחרו "אוטומטי" או מודל אחר.`, 'ATTACHMENTS_UNSUPPORTED');
  }
}

/** What the model gets besides the messages: the instructions, project_state.md and any GitHub context. */
export function composeSystem({ memory, github }) {
  let system = BASE_SYSTEM;
  if (memory) system += `\n\n# project_state.md\nThe conversation's memory: a summary of the earlier messages, which you no longer see. Treat it as reliable context.\n\n${memory}`;
  if (github) system += `\n\n# GitHub context\nCode the user referenced in this message, read from GitHub:\n\n${github}`;
  return system;
}

/** The latest messages that fit the context budget, oldest first, starting with the user. */
function contextOf(messages) {
  const chosen = [];
  let total = 0;
  for (const [index, message] of [...messages.entries()].reverse()) {
    if (!message.content || (message.role !== 'user' && message.role !== 'assistant')) continue;
    total += message.content.length;
    if (total > HISTORY_CHARS && chosen.length) break;
    // Earlier attachments aren't sent again; the model learns they were there.
    const earlier = index < messages.length - 1;
    const note = earlier && message.attachments?.length ? `\n\n[קבצים מצורפים: ${message.attachments.map((item) => item.name).join(', ')}]` : '';
    chosen.unshift({ role: message.role, content: `${message.content}${note}` });
  }
  while (chosen.length && chosen[0].role !== 'user') chosen.shift();
  return chosen;
}

const titleFrom = (text) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
};

const summaryOf = (chat) => ({ id: chat.id, title: chat.title, workspace: chat.workspace ?? null, ...listColumns(chat), createdAt: chat.createdAt, updatedAt: chat.updatedAt });

/** @param {{ store: import('../lib/jsonStore.js').JsonStore }} deps */
export function chatRouter({ store }) {
  const router = Router();
  const streaming = new Map(); // conversation id → AbortController
  const compacting = new Map(); // conversation id → Promise (never rejects)

  // The signed-in person's conversation: someone else's reads as missing.
  const load = async (req, id) => {
    const chat = await chatSessions(req.user.id).get(id);
    if (!chat) throw new HttpError(404, 'השיחה לא נמצאה. ייתכן שהיא נמחקה.', 'NOT_FOUND');
    return chat;
  };

  async function saveBundle(ownerId, chat, messageId, files) {
    const { buffer, fileName } = zipFiles(files);
    const id = randomUUID();
    await fs.mkdir(config.paths.bundles, { recursive: true });
    await fs.writeFile(path.join(config.paths.bundles, `${id}.zip`), buffer);
    const record = {
      id,
      ownerId,
      conversationId: chat.id,
      messageId,
      name: fileName,
      size: buffer.length,
      files: files.map((file) => ({ path: file.path, size: Buffer.byteLength(file.content) })),
      createdAt: new Date().toISOString(),
    };
    await store.insert('bundles', record);
    return { id, name: fileName, size: record.size, files: record.files, url: `/api/chat/bundles/${id}` };
  }

  // Temporary files: code ZIPs expire (they are rebuilt from the answer when downloaded again),
  // and uploads that never made it into a message are removed after a day.
  async function sweep() {
    const now = Date.now();
    for (const bundle of store.list('bundles')) {
      if (now - Date.parse(bundle.createdAt) > config.chat.bundleTtlHours * HOUR) await fs.rm(path.join(config.paths.bundles, `${bundle.id}.zip`), { force: true });
    }
    for (const record of store.list('attachments')) {
      if (!record.conversationId && now - Date.parse(record.createdAt) > 24 * HOUR) {
        await fs.rm(attachmentPath(record), { force: true });
        await store.remove('attachments', record.id);
      }
    }
  }
  sweep().catch((error) => console.warn(`[chat] Cleanup failed: ${error.message}`));
  setInterval(() => sweep().catch((error) => console.warn(`[chat] Cleanup failed: ${error.message}`)), HOUR).unref();

  // Learning after an answer: what the exchange taught about the person, written down by a cheap model.
  const learning = new Map(); // chat id → its learning job
  function learnInBackground(userId, chatId, messageId, userText, answer) {
    const meter = createMeter();
    const job = meter
      .run(() => withTags({ role: 'learning' }, () => learnFrom({ userId, userText, answer, conversationId: chatId })))
      .catch((error) => {
        console.warn(`[memory] Learning failed: ${error.log ?? error.message}`);
        return null;
      })
      .then(async (outcome) => {
        // The learning's calls are part of the answer's cost, even when it failed.
        if (meter.calls.length) {
          await chatSessions(userId).change(chatId, (current) => ({
            messages: current.messages.map((message) => (message.id === messageId ? { ...message, usage: storedUsage([...callsOf(message), ...meter.calls]) } : message)),
          }));
        }
        if (outcome && (outcome.added.length || outcome.updated.length)) console.log(`[memory] Learned ${outcome.added.length} new and updated ${outcome.updated.length} from a conversation.`);
        return outcome;
      })
      .finally(() => {
        if (learning.get(chatId) === job) learning.delete(chatId);
      });
    learning.set(chatId, job);
    return job;
  }

  function compactInBackground(userId, current) {
    const chatId = current.id;
    const meter = createMeter();
    const job = meter.run(() => withTags({ role: 'memory' }, () => compactConversation(current))).then(async (memory) => {
      // The memory's own model calls are part of the conversation's cost.
      const updated = await chatSessions(userId).change(chatId, (latest) => ({ memory: { ...memory, calls: [...(latest.memory?.calls ?? []), ...meter.calls] } }));
      return updated?.memory ?? { ...memory, calls: meter.calls };
    });
    compacting.set(
      chatId,
      job.catch(() => null).finally(() => compacting.delete(chatId)),
    );
    return job;
  }

  router.get('/catalog', async (req, res) => {
    res.json(await chatCatalog());
  });

  router.get('/conversations', async (req, res) => {
    res.json({ conversations: await chatSessions(req.user.id).list() });
  });

  router.post('/conversations', async (req, res) => {
    const now = new Date().toISOString();
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 120) : '';
    await ensureUser(req.user);
    const chat = await chatSessions(req.user.id).create({ id: randomUUID(), title });
    res.status(201).json({ conversation: { ...summaryOf(chat), messages: [], memory: memoryInfo(chat) } });
  });

  router.get('/conversations/:id', async (req, res) => {
    const chat = await load(req, req.params.id);
    res.json({ conversation: { ...summaryOf(chat), messages: chat.messages.map(withCosts), memory: memoryInfo(chat), usage: totalsOf(conversationUsage(chat)) } });
  });

  router.get('/conversations/:id/usage', async (req, res) => {
    const chats = chatSessions(req.user.id);
    const chat = await chats.get(req.params.id);
    if (!chat) throw new HttpError(404, 'השיחה לא נמצאה.', 'NOT_FOUND');
    // This person's totals: their conversations only.
    const everything = await chats.everything();
    const calls = everything.flatMap(conversationCalls);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    res.json({
      usage: conversationUsage(chat),
      month: totalsOf(summarize(calls.filter((call) => new Date(call.at) >= monthStart))),
      all: { ...totalsOf(summarize(calls)), conversations: everything.length },
      pricesChecked: PRICES_CHECKED,
      currency: 'USD',
    });
  });

  router.patch('/conversations/:id', async (req, res) => {
    await load(req, req.params.id);
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 120) : '';
    if (!title) throw new HttpError(400, 'לשיחה צריך להיות שם.', 'INVALID_TITLE');
    res.json({ conversation: summaryOf(await chatSessions(req.user.id).update(req.params.id, { title })) });
  });

  router.delete('/conversations/:id', async (req, res) => {
    await load(req, req.params.id);
    streaming.get(req.params.id)?.abort();
    for (const bundle of store.list('bundles').filter((item) => item.conversationId === req.params.id)) {
      await fs.rm(path.join(config.paths.bundles, `${bundle.id}.zip`), { force: true });
      await store.remove('bundles', bundle.id);
    }
    for (const record of store.list('attachments').filter((item) => item.conversationId === req.params.id)) {
      await fs.rm(attachmentPath(record), { force: true });
      await store.remove('attachments', record.id);
    }
    await chatSessions(req.user.id).remove(req.params.id);
    res.status(204).end();
  });

  router.get('/conversations/:id/memory', async (req, res) => {
    const chat = await load(req, req.params.id);
    const memory = memoryInfo(chat);
    if (req.query.download === '1') {
      res.attachment('project_state.md');
      res.type('text/markdown; charset=utf-8');
      return res.send(memory.state || '# project_state.md\n');
    }
    res.json({ memory });
  });

  router.post('/conversations/:id/memory/compact', async (req, res) => {
    const chat = await load(req, req.params.id);
    if (streaming.has(chat.id)) throw new HttpError(409, 'כבר נכתבת תשובה בשיחה הזו. אפשר לעדכן את הזיכרון אחריה.', 'BUSY');
    await compacting.get(chat.id);
    const latest = await load(req, chat.id);
    if (!latest.messages.some((message) => message.content)) throw new HttpError(400, 'אין עדיין הודעות לסכם.', 'NOTHING_TO_COMPACT');
    await requireCredits(req.user);
    try {
      await compactInBackground(req.user.id, latest);
    } catch (error) {
      if (error instanceof AiError) throw new HttpError(502, error.message, error.code, error.detail ? { detail: error.detail } : undefined);
      throw error;
    }
    res.json({ memory: memoryInfo(await load(req, chat.id)) });
  });

  // A development-team run, live, for its dashboard: Server-Sent Events. EventSource can't send headers,
  // so this GET signs in with the session cookie; only the run's owner gets it.
  router.get('/runs/:id/events', (req, res, next) => {
    if (!findRun(req.params.id, req.user.id)) return next(new HttpError(404, 'הריצה לא נמצאה: היא הסתיימה מזמן, או שאינה שלך.', 'RUN_NOT_FOUND'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    let stop = null;
    let closed = false;
    // A comment every 15 seconds keeps proxies from closing a quiet connection.
    const heartbeat = setInterval(() => !closed && res.write(': ping\n\n'), 15_000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      stop?.();
      res.end();
    };
    stop = subscribeRun(req.params.id, req.user.id, (event) => {
      if (closed) return;
      if (event.end) {
        res.write('event: end\ndata: {}\n\n');
        close();
      } else res.write(`id: ${event.id}\nevent: ${event.snapshot ? 'snapshot' : 'patch'}\ndata: ${JSON.stringify(event.snapshot ?? event.patches)}\n\n`);
    });
    req.on('close', close);
  });

  // A generated project of a conversation: its files at a version (the latest by default), and its live preview.
  router.get('/conversations/:id/artifacts/:artifactId', async (req, res) => {
    const chat = await load(req, req.params.id);
    const version = /^\d+$/.test(String(req.query.version ?? '')) ? Number(req.query.version) : null;
    const state = artifactState(chat.messages, req.params.artifactId, version);
    if (!state) throw new HttpError(404, 'הפרויקט הזה לא נמצא בשיחה.', 'ARTIFACT_NOT_FOUND');
    const purposeOf = (path) => state.blueprint?.files?.find((file) => file.path === path)?.purpose ?? '';
    res.json({
      artifact: {
        id: state.id,
        version: state.version,
        latest: state.latest,
        messageId: state.messageId,
        title: state.blueprint?.title ?? '',
        summary: state.summary,
        files: [...state.files].map(([path, content]) => ({ path, content, purpose: purposeOf(path) })),
        preview: previewInfo(state.id, req.user.id),
        sandbox: Boolean(sandboxFor(req.user) && config.sandbox.preview.enabled),
      },
    });
  });

  router.get('/conversations/:id/artifacts/:artifactId/preview', async (req, res) => {
    const chat = await load(req, req.params.id);
    if (!artifactState(chat.messages, req.params.artifactId)) throw new HttpError(404, 'הפרויקט הזה לא נמצא בשיחה.', 'ARTIFACT_NOT_FOUND');
    // sandbox: whether this person may bring an ended preview back.
    res.json({ preview: previewInfo(req.params.artifactId, req.user.id), sandbox: Boolean(sandboxFor(req.user) && config.sandbox.preview.enabled) });
  });

  // Brings a preview that ended back, from the project's latest version: it starts in the background.
  router.post('/conversations/:id/artifacts/:artifactId/preview', async (req, res) => {
    const chat = await load(req, req.params.id);
    const state = artifactState(chat.messages, req.params.artifactId);
    if (!state) throw new HttpError(404, 'הפרויקט הזה לא נמצא בשיחה.', 'ARTIFACT_NOT_FOUND');
    if (!sandboxFor(req.user) || !config.sandbox.preview.enabled) throw new HttpError(403, 'תצוגה חיה דורשת סביבה מבודדת (Docker או E2B) שהופעלה בשרת לחשבון הזה.', 'PREVIEW_UNAVAILABLE');
    res.json({ preview: revivePreview({ id: state.id, ownerId: req.user.id, blueprint: state.blueprint, files: state.files, version: state.version }) });
  });

  router.get('/bundles/:id', async (req, res) => {
    const bundle = store.get('bundles', req.params.id);
    if (!bundle || bundle.ownerId !== req.user.id) throw new HttpError(404, 'קובץ ה-ZIP לא נמצא. ייתכן שהשיחה נמחקה.', 'NOT_FOUND');
    const file = path.join(config.paths.bundles, `${bundle.id}.zip`);
    try {
      await fs.access(file);
    } catch {
      // The temporary ZIP expired: build it again from the answer it came from.
      const conversation = await chatSessions(req.user.id).get(bundle.conversationId);
      const message = conversation?.messages.find((item) => item.id === bundle.messageId);
      // A project's version is rebuilt whole (an edit's answer holds only what it changed).
      const state = message?.artifact ? artifactState(conversation.messages, message.artifact.id, message.artifact.version) : null;
      const files = state ? [...state.files].map(([file, content]) => ({ path: file, content })) : message ? extractCodeFiles(message.content) : [];
      if (files.length < 2) throw new HttpError(404, 'קובץ ה-ZIP פג תוקף, והתשובה שממנה נבנה כבר לא קיימת.', 'NOT_FOUND');
      await fs.mkdir(config.paths.bundles, { recursive: true });
      await fs.writeFile(file, zipFiles(files).buffer);
      await store.update('bundles', bundle.id, { createdAt: new Date().toISOString() });
    }
    res.set('X-Content-Type-Options', 'nosniff');
    await new Promise((resolve, reject) => res.download(file, bundle.name, (error) => (error ? reject(error) : resolve())));
  });

  // The chat's generators make media with the studio (POST /api/media/generate); this adds the
  // request and the result to the conversation, so they stay in it and later models know about them.
  router.post('/conversations/:id/media', async (req, res) => {
    const chat = await load(req, req.params.id);
    if (streaming.has(chat.id)) throw new HttpError(409, 'כבר נכתבת תשובה בשיחה הזו. חכו שתסתיים או עצרו אותה.', 'BUSY');
    const kind = Object.hasOwn(GENERATED, req.body?.kind) ? req.body.kind : null;
    if (!kind) throw new HttpError(400, 'סוג המדיה אינו תקין.', 'INVALID_KIND');
    const record = typeof req.body?.mediaId === 'string' ? store.get('media', req.body.mediaId) : null;
    if (!record || record.kind !== kind || record.ownerId !== req.user.id) throw new HttpError(400, 'קובץ המדיה לא נמצא. צרו אותו שוב.', 'MEDIA_NOT_FOUND');
    const now = new Date().toISOString();
    const userMessage = { id: randomUUID(), role: 'user', content: record.prompt, tool: kind, createdAt: now };
    const message = {
      id: randomUUID(),
      role: 'assistant',
      content: `[${GENERATED[kind]} ב-Pollinations (${record.model}) לפי הבקשה: "${record.prompt}"]`,
      media: { id: record.id, kind, prompt: record.prompt, model: record.model, mime: record.mime, size: record.size, url: `/api/media/${record.id}/file` },
      label: 'Pollinations',
      ms: record.ms,
      createdAt: now,
    };
    const saved = await chatSessions(req.user.id).change(chat.id, (current) => ({ messages: [...current.messages, userMessage, message], title: current.title || titleFrom(record.prompt), updatedAt: now }));
    if (!saved) throw new HttpError(404, 'השיחה לא נמצאה.', 'NOT_FOUND');
    res.status(201).json({ userMessage, message, conversation: summaryOf(saved) });
  });

  router.post('/attachments', acceptChatMedia, async (req, res) => {
    if (!req.file) throw new HttpError(400, 'לא התקבל קובץ.', 'NO_FILE');
    const kind = kindOf(req.file.mimetype);
    const limitMb = kind === 'image' ? config.chat.imageMaxMb : config.chat.videoMaxMb;
    if (req.file.size > limitMb * MB) {
      await fs.rm(req.file.path, { force: true });
      throw new HttpError(413, kind === 'image' ? `תמונה יכולה להיות עד ${limitMb}MB.` : `וידאו יכול להיות עד ${limitMb}MB.`, 'FILE_TOO_LARGE');
    }
    const record = {
      id: randomUUID(),
      ownerId: req.user.id,
      file: path.basename(req.file.path),
      name: displayName(req.file.originalname, kind === 'image' ? 'image' : 'video'),
      mime: req.file.mimetype,
      kind,
      size: req.file.size,
      conversationId: null,
      createdAt: new Date().toISOString(),
    };
    await store.insert('attachments', record);
    res.status(201).json({ attachment: publicAttachment(record) });
  });

  router.get('/attachments/:id', (req, res) => {
    const record = store.get('attachments', req.params.id);
    if (!record || record.ownerId !== req.user.id) throw new HttpError(404, 'הקובץ המצורף לא נמצא.', 'NOT_FOUND');
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; media-src 'self'; img-src 'self'; sandbox" });
    res.type(record.mime);
    res.sendFile(attachmentPath(record));
  });

  router.delete('/attachments/:id', async (req, res) => {
    const record = store.get('attachments', req.params.id);
    if (record && record.ownerId === req.user.id && !record.conversationId) {
      await fs.rm(attachmentPath(record), { force: true });
      await store.remove('attachments', record.id);
    }
    res.status(204).end();
  });

  router.post('/conversations/:id/messages', async (req, res) => {
    const chats = chatSessions(req.user.id);
    let chat = await load(req, req.params.id);
    if (streaming.has(chat.id)) throw new HttpError(409, 'כבר נכתבת תשובה בשיחה הזו. חכו שתסתיים או עצרו אותה.', 'BUSY');
    await compacting.get(chat.id); // a compaction started after the previous answer
    chat = await load(req, chat.id);
    // The turn knows whose it is, so recall reads only this person's memories.
    const request = { ...validateTurn(req.body), userId: req.user.id };

    let messages = chat.messages;
    let userMessage = null;
    let records = [];
    if (req.body?.regenerate) {
      while (messages.length && messages.at(-1).role === 'assistant') messages = messages.slice(0, -1);
      if (!messages.length) throw new HttpError(400, 'אין הודעה לענות עליה מחדש.', 'NOTHING_TO_REGENERATE');
      records = (messages.at(-1).attachments ?? []).map((item) => store.get('attachments', item.id)).filter((record) => record && record.ownerId === req.user.id);
    } else {
      const ids = Array.isArray(req.body?.attachments) ? [...new Set(req.body.attachments.filter((id) => typeof id === 'string'))].slice(0, MAX_IMAGES + 1) : [];
      records = ids.map((id) => store.get('attachments', id));
      if (records.some((record) => !record || record.ownerId !== req.user.id || (record.conversationId && record.conversationId !== chat.id))) {
        throw new HttpError(400, 'אחד הקבצים המצורפים לא נמצא. צרפו אותו שוב.', 'ATTACHMENT_NOT_FOUND');
      }
      const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
      if (!content) throw new HttpError(400, 'אי אפשר לשלוח הודעה ריקה.', 'EMPTY_MESSAGE');
      if (content.length > MAX_MESSAGE_CHARS) {
        throw new HttpError(413, `ההודעה ארוכה מדי: עד ${MAX_MESSAGE_CHARS.toLocaleString('he-IL')} תווים.`, 'MESSAGE_TOO_LONG');
      }
      userMessage = { id: randomUUID(), role: 'user', content, createdAt: new Date().toISOString() };
      if (request.artifact) userMessage.artifact = { id: request.artifact };
      if (records.length) userMessage.attachments = records.map(publicAttachment);
      messages = [...messages, userMessage];
    }
    validateAttachments(request, records);
    const first = !messages.slice(0, -1).some((message) => message.role === 'assistant' && message.content && !message.error && !message.media);
    const lastUser = messages.findLast((message) => message.role === 'user');
    // A follow-up on a generated project: the team plans a patch on its latest version instead of a new project.
    // Answering an edit again edits again.
    if (!request.artifact && req.body?.regenerate && lastUser?.artifact?.id) request.artifact = lastUser.artifact.id;
    const edit = request.artifact ? artifactState(messages, request.artifact) : null;
    if (request.artifact) {
      if (!edit) throw new HttpError(404, 'הפרויקט הזה לא נמצא בשיחה.', 'ARTIFACT_NOT_FOUND');
      if (request.workspace !== 'premium' || !config.chat.pipeline.enabled) throw new HttpError(400, 'עריכת פרויקט דורשת את צוות הפיתוח, בסביבת הפרימיום.', 'ARTIFACT_EDIT_UNAVAILABLE');
      Object.assign(request, { pipeline: 'force', emergency: false });
    }
    // Credits: checked, and a premium answer's price reserved, before anything is saved or any model is called
    // (402 when there aren't enough). The development team changes the price to its files once it has a plan.
    const hold = await reserveCredits(req.user, request.workspace === 'premium' ? config.credits.perAnswer : 0);
    let opened = null;
    try {
      for (const record of records) if (!record.conversationId) await store.update('attachments', record.id, { conversationId: chat.id });
      // The turn starts from the stored conversation: the question added (or, to answer again, the old answer removed).
      opened = await chats.change(chat.id, (current) => {
        let next = current.messages;
        if (userMessage) next = [...next, userMessage];
        else while (next.length && next.at(-1).role === 'assistant') next = next.slice(0, -1);
        return { messages: next, title: current.title || titleFrom(lastUser.content), workspace: request.workspace, updatedAt: new Date().toISOString() };
      });
    } finally {
      if (!opened) await hold.release();
    }
    if (!opened) throw new HttpError(404, 'השיחה לא נמצאה. ייתכן שהיא נמחקה.', 'NOT_FOUND');
    chat = opened;
    messages = opened.messages;

    res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event) => {
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
    };
    const assistantId = randomUUID();
    send({ type: 'start', userMessage, assistantId, title: chat.title });

    const controller = new AbortController();
    streaming.set(chat.id, controller);
    const stopOnDisconnect = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on('close', stopOnDisconnect);

    let text = '';
    let reasoning = '';
    let route = null;
    let team = null;
    let research = null;
    let recalled = null;
    let pipelineId = null;
    const experts = [];
    const emit = (event) => {
      if (event.type === 'text') text += event.text;
      else if (event.type === 'reasoning') reasoning += event.text;
      else if (event.type === 'expert') experts.push(event.expert);
      else if (event.type === 'route') route = event.route;
      else if (event.type === 'team') team = event.team;
      else if (event.type === 'research') research = event.research;
      else if (event.type === 'recall') recalled = event.memories;
      else if (event.type === 'pipeline') pipelineId = event.runId;
      send(event);
    };
    const started = Date.now();
    const base = { id: assistantId, role: 'assistant', effort: request.effort, workspace: request.workspace, createdAt: new Date().toISOString() };
    // The conversation's cost so far, sent after every model call so the meter moves while the answer is written.
    const meter = createMeter({
      onCall: () => {
        const running = { ...base, usage: storedUsage(meter.calls) };
        send({ type: 'usage', conversationUsage: totalsOf(conversationUsage({ ...chat, messages: [...messages, running] })) });
      },
    });
    let assistant;
    let projectFiles = null; // a team answer's whole project, for its ZIP (an edit's answer shows only what changed)
    try {
      await meter.run(async () => {
        // GitHub repositories mentioned in the message are read for this turn.
        let github = null;
        try {
          github = await githubContextFor(lastUser.content);
        } catch (error) {
          console.warn(`[github] Chat context failed: ${error.message}`);
        }
        if (github) {
          send({ type: 'context', github: github.summary });
          const withContext = await chats.change(chat.id, (current) => ({
            messages: current.messages.map((message) => (message.id === lastUser.id ? { ...message, context: { github: github.summary } } : message)),
          }));
          if (withContext) {
            chat = withContext;
            messages = withContext.messages;
          }
        }
        const media = records.length
          ? await loadMedia(records, { onUpload: () => send({ type: 'stage', stage: 'upload', label: 'מעלה את הווידאו ל-Gemini' }) })
          : [];
        const result = await runTurn({
          request,
          system: composeSystem({ memory: chat.memory?.state, github: github?.text }),
          messages: contextOf(contextWindow({ ...chat, messages })),
          media,
          first,
          signal: controller.signal,
          emit,
          credits: hold,
          user: req.user,
          edit: edit && { version: edit.version, blueprint: edit.blueprint, files: edit.files },
          artifactId: edit ? edit.id : assistantId,
        });
        assistant = {
          ...base,
          content: result.text,
          reasoning: reasoning.trim() || undefined,
          experts: result.experts ?? undefined,
          team: result.team ?? undefined,
          research: result.research ?? undefined,
          recalled: result.recalled ?? undefined,
          continuations: result.continuations ?? undefined,
          route: result.route,
          strategy: result.strategy,
          provider: result.target.provider,
          providerName: result.target.providerName,
          model: result.target.model,
          label: result.target.label,
          ms: result.ms,
          usage: result.usage,
        };
        // A team answer is a project's version: 1 for a new one, the next for an edit (see services/chat/artifacts.js).
        if (result.artifact) {
          assistant.artifact = {
            id: edit ? edit.id : assistantId,
            version: edit ? edit.version + 1 : 1,
            blueprint: result.artifact.blueprint,
            ...(edit ? { base: edit.version, changed: result.artifact.changed, deleted: result.artifact.deleted, summary: result.artifact.summary } : {}),
          };
          projectFiles = result.artifact.files;
        }
        // Stopped, the team returns what it has: its files hadn't arrived, so the answer counts as stopped.
        if (controller.signal.aborted && result.strategy === 'pipeline') assistant.stopped = true;
      });
    } catch (error) {
      const stopped = controller.signal.aborted;
      const known = error instanceof AiError || error instanceof CreditError;
      if (!stopped) {
        if (error instanceof AiError) console.warn(`[ai] Chat turn failed: ${error.log}`);
        else if (!known) console.error(error);
      }
      assistant = {
        ...base,
        content: text,
        reasoning: reasoning.trim() || undefined,
        experts: experts.length ? experts : undefined,
        team: team ?? undefined,
        research: research ?? undefined,
        recalled: recalled ?? undefined,
        route: route ?? undefined,
        providerName: route?.providerName,
        model: route?.model,
        label: route?.label,
        ms: Date.now() - started,
        ...(stopped
          ? { stopped: true }
          : {
              error: {
                message: known ? error.message : 'אירעה שגיאה לא צפויה בזמן כתיבת התשובה.',
                detail: error.detail ?? null,
                code: error.code ?? 'ERROR',
                ...(error instanceof CreditError ? { credits: error.credits, needed: error.needed } : {}),
              },
            }),
      };
    } finally {
      streaming.delete(chat.id);
      res.off('close', stopOnDisconnect);
    }
    // Every model call of the turn (router, answer, continuations, experts…), also when it failed or was stopped.
    if (meter.calls.length) assistant.usage = storedUsage(meter.calls);
    // Credits: a failed answer costs nothing, and neither does a team answer stopped before its files arrived.
    const teamWork = assistant.strategy === 'pipeline' || route?.mode === 'pipeline';
    if (assistant.error || (assistant.stopped && (teamWork || !assistant.content))) await hold.release();
    if (hold.amount) assistant.credits = hold.amount;

    // Multi-file code answers become a ZIP.
    if (!assistant.error && !assistant.stopped) {
      // A project's ZIP holds the whole project at this version (an edit's answer shows only what changed).
      const report = extractCodeFiles(assistant.content).filter((file) => file.path === 'QA_REPORT.md');
      const files = projectFiles ? [...[...projectFiles].map(([file, content]) => ({ path: file, content })), ...report] : extractCodeFiles(assistant.content);
      if (files.length >= 2) {
        try {
          assistant.bundle = await saveBundle(req.user.id, chat, assistant.id, files);
          send({ type: 'bundle', bundle: assistant.bundle });
        } catch (error) {
          console.warn(`[chat] Packaging the code failed: ${error.message}`);
        }
      }
    }
    // The balance after the charge travels with the answer, so the badge updates at once.
    const balance = unlimited(req.user) ? undefined : await balanceOf(req.user).catch(() => undefined);
    // A development-team run ends here: the ZIP and the credits are the route's to report, and its final
    // state is saved with the answer (the dashboard of a reloaded conversation shows it).
    const run = pipelineId ? findRun(pipelineId, req.user.id) : null;
    if (run) {
      const free = unlimited(req.user);
      const charged = free ? 0 : (assistant.credits ?? 0);
      const bundle = assistant.bundle;
      run.patch(
        { op: 'merge', at: ['package'], value: bundle ? { status: 'done', bundle: { url: bundle.url ?? null, name: bundle.name ?? null, files: Array.isArray(bundle.files) ? bundle.files.length : (bundle.files ?? null), size: bundle.size ?? null } } : { status: assistant.error || assistant.stopped ? 'waiting' : 'failed' } },
        { op: 'merge', at: ['credits'], value: { status: 'done', charged, after: balance ?? null, before: balance === undefined ? null : balance + charged, unlimited: free } },
      );
      run.finish(assistant.error ? 'failed' : assistant.stopped ? 'stopped' : 'done', assistant.error ? { error: assistant.error.message ?? String(assistant.error) } : {});
      assistant.pipeline = run.snapshot();
    }
    // The answer joins the stored conversation (which may have changed meanwhile, for example the previous answer's cost).
    const saved = await chats.change(chat.id, (current) => ({ messages: [...current.messages.filter((message) => message.id !== assistant.id), assistant], updatedAt: new Date().toISOString() }));
    const usageNow = totalsOf(conversationUsage(saved ?? { ...chat, messages: [...messages, assistant] }));
    send({ type: assistant.error ? 'error' : 'done', message: withCosts(assistant), conversationUsage: usageNow, ...(balance !== undefined ? { credits: balance } : {}) });

    // A successful premium answer teaches the long-term memory, in the background.
    if (!assistant.error && !assistant.stopped && request.workspace === 'premium' && request.memory) {
      learnInBackground(req.user.id, chat.id, assistant.id, lastUser.content, assistant.content);
    }

    // Every CHAT_COMPACT_EVERY turns, project_state.md is rewritten and the context shrinks.
    if (saved && !assistant.error && !assistant.stopped && compactionDue(saved)) {
      send({ type: 'memory', status: 'updating' });
      try {
        await compactInBackground(req.user.id, saved);
        const compacted = (await chats.get(chat.id)) ?? saved;
        send({ type: 'memory', status: 'updated', memory: memoryInfo(compacted), conversationUsage: totalsOf(conversationUsage(compacted)) });
      } catch (error) {
        console.warn(`[memory] Compaction failed: ${error.log ?? error.message}`);
        send({ type: 'memory', status: 'failed', message: error.message });
      }
    }
    res.end();
  });

  return router;
}
