#!/usr/bin/env node
/**
 * Moves what a Stash from before accounts kept on this computer into the cloud database, for one account:
 *   - conversations from server/storage/db.json            → chat_sessions
 *   - long-term memories from server/storage/memory.db      → memories
 *   - attachments, ZIPs and media made before accounts      → owned by that account
 *
 *   npm run db:import -w server -- --email you@example.com [--storage <folder>] [--dry-run]
 *
 * The account must have signed in once (that makes its row in the users table), and the database must
 * be migrated (npm run db:migrate -w server). Stop the server first: it keeps db.json in memory and would
 * write over the owners set here. Running it again is safe: what was imported before is skipped. Ids are
 * kept, so links to conversations and downloaded ZIPs stay valid.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { config } from '../src/config.js';
import { closeDb, db } from '../src/lib/db.js';
import { isUuid } from '../src/lib/ids.js';
import { JsonStore } from '../src/lib/jsonStore.js';
import { listColumns } from '../src/services/chat/chatSessions.js';

const { values: args } = parseArgs({
  options: { email: { type: 'string' }, storage: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } },
});
if (args.help || !args.email) {
  console.log('Usage: npm run db:import -w server -- --email you@example.com [--storage <folder>] [--dry-run]');
  process.exit(args.help ? 0 : 1);
}
const dryRun = args['dry-run'];
const storage = path.resolve(args.storage ?? path.dirname(config.paths.database));
const dates = (value, fallback = new Date()) => (value && !Number.isNaN(Date.parse(value)) ? new Date(value) : fallback);

const prisma = db();
try {
  const user = await prisma.user.findUnique({ where: { email: args.email.trim().toLowerCase() } });
  if (!user) throw new Error(`No account with ${args.email}. Sign in to Stash once with it, then run this again.`);
  console.log(`${dryRun ? 'Checking' : 'Importing'} ${storage} for ${user.email}${dryRun ? ' (dry run: nothing is written)' : ''}`);

  // Conversations.
  const store = new JsonStore(path.join(storage, 'db.json'));
  await store.init();
  const chats = store.list('chats').filter((chat) => isUuid(chat.id) && Array.isArray(chat.messages));
  const existing = new Set((await prisma.chatSession.findMany({ where: { id: { in: chats.map((chat) => chat.id) } }, select: { id: true } })).map((row) => row.id));
  const newChats = chats.filter((chat) => !existing.has(chat.id));
  if (!dryRun && newChats.length) {
    await prisma.chatSession.createMany({
      data: newChats.map((chat) => ({
        id: chat.id,
        userId: user.id,
        title: String(chat.title ?? '').slice(0, 200),
        workspace: chat.workspace ?? null,
        messages: JSON.parse(JSON.stringify(chat.messages)),
        ...(chat.memory ? { memory: JSON.parse(JSON.stringify(chat.memory)) } : {}),
        ...listColumns(chat),
        createdAt: dates(chat.createdAt),
        updatedAt: dates(chat.updatedAt, dates(chat.createdAt)),
      })),
      skipDuplicates: true,
    });
  }
  console.log(`Conversations: ${newChats.length} ${dryRun ? 'to import' : 'imported'}, ${chats.length - newChats.length} already there.`);

  // Memories, from the SQLite file of the previous version.
  const file = path.join(storage, 'memory.db');
  if (existsSync(file)) {
    const { DatabaseSync } = await import('node:sqlite');
    const sqlite = new DatabaseSync(file, { readOnly: true });
    const rows = sqlite.prepare('SELECT * FROM memories').all();
    sqlite.close();
    const known = new Set((await prisma.memory.findMany({ where: { id: { in: rows.map((row) => row.id).filter(isUuid) } }, select: { id: true } })).map((row) => row.id));
    const mine = new Set((await prisma.chatSession.findMany({ where: { userId: user.id }, select: { id: true } })).map((row) => row.id));
    const fresh = rows.filter((row) => isUuid(row.id) && !known.has(row.id) && ['preference', 'style', 'rule', 'fact'].includes(row.kind));
    if (!dryRun && fresh.length) {
      await prisma.memory.createMany({
        data: fresh.map((row) => ({
          id: row.id,
          userId: user.id,
          kind: row.kind,
          content: row.content,
          project: row.project ? String(row.project).slice(0, 120) : null,
          source: row.source === 'user' ? 'user' : 'learned',
          chatSessionId: mine.has(row.conversation_id) || (dryRun && newChats.some((chat) => chat.id === row.conversation_id)) ? row.conversation_id : null,
          embedding: row.embedding ? Buffer.from(row.embedding, 'base64') : null,
          embeddingModel: row.embedding ? row.embedding_model : null,
          confirmations: Number(row.confirmations) || 1,
          uses: Number(row.uses) || 0,
          createdAt: dates(row.created_at),
          updatedAt: dates(row.updated_at, dates(row.created_at)),
          lastUsedAt: row.last_used_at ? dates(row.last_used_at) : null,
        })),
        skipDuplicates: true,
      });
    }
    console.log(`Memories: ${fresh.length} ${dryRun ? 'to import' : 'imported'}, ${rows.length - fresh.length} already there or unreadable.`);
  } else {
    console.log('Memories: no memory.db here.');
  }

  // Files and records that had no owner before accounts.
  const owned = {};
  for (const collection of ['attachments', 'bundles', 'media']) {
    const orphans = store.list(collection).filter((record) => !record.ownerId);
    owned[collection] = orphans.length;
    if (!dryRun) for (const record of orphans) await store.update(collection, record.id, { ownerId: user.id });
  }
  if (!dryRun) await store.flush();
  console.log(`Owner set: ${owned.attachments} attachments, ${owned.bundles} ZIPs, ${owned.media} media.`);
} catch (error) {
  console.error(`Import failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await closeDb().catch(() => {});
}
