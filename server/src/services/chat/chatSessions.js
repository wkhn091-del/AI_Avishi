/**
 * A person's conversations, in the chat_sessions table (PostgreSQL). Every method is scoped to one
 * user: another person's conversation reads as missing, and can't be changed or deleted.
 *
 * A conversation keeps its messages as JSON, so changing it is read-modify-write. change() does that
 * in a transaction holding the row's lock (SELECT … FOR UPDATE), so an answer being saved, the learner
 * adding its cost and the summary being written never overwrite one another.
 */
import { db } from '../../lib/db.js';
import { isUuid } from '../../lib/ids.js';
import { conversationUsage } from './usage.js';

const LIST = { id: true, title: true, workspace: true, messageCount: true, cost: true, tokens: true, createdAt: true, updatedAt: true };

/** A row as the chat code knows a conversation: ISO times, and messages and memory as they were stored. */
const toChat = (row) => ({
  id: row.id,
  title: row.title,
  workspace: row.workspace ?? null,
  messages: Array.isArray(row.messages) ? row.messages : [],
  ...(row.memory ? { memory: row.memory } : {}),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** What the conversation list shows about a conversation, kept in columns so the list never reads messages. */
export function listColumns(chat) {
  const usage = conversationUsage(chat);
  return {
    messageCount: chat.messages.length,
    // Estimated cost in USD (null when no call has a known price).
    cost: usage.calls && usage.unpriced === usage.calls ? null : usage.cost,
    tokens: usage.input + usage.output,
  };
}

// JSON as it will read back: no undefined fields.
const plain = (value) => JSON.parse(JSON.stringify(value));

export function chatSessions(userId) {
  const prisma = db();
  return {
    /** The conversation list, most recent first. */
    async list() {
      const rows = await prisma.chatSession.findMany({ where: { userId }, select: LIST, orderBy: { updatedAt: 'desc' } });
      return rows.map((row) => ({ ...row, workspace: row.workspace ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
    },

    async get(id) {
      if (!isUuid(id)) return null;
      const row = await prisma.chatSession.findFirst({ where: { id, userId } });
      return row ? toChat(row) : null;
    },

    async create({ id, title = '' }) {
      return toChat(await prisma.chatSession.create({ data: { id, userId, title } }));
    },

    /**
     * Changes a conversation: `apply(current)` returns the fields to set (title, workspace, messages,
     * memory, updatedAt), or null for none. It runs while the row is locked and mustn't touch the
     * database itself. Returns the conversation as saved, or null when it isn't this person's.
     */
    async change(id, apply) {
      if (!isUuid(id)) return null;
      return prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw`SELECT id FROM chat_sessions WHERE id = ${id}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
        if (!locked.length) return null;
        const current = toChat(await tx.chatSession.findUnique({ where: { id } }));
        const patch = apply(current);
        if (!patch) return current;
        const data = {};
        for (const key of ['title', 'workspace']) if (key in patch) data[key] = patch[key];
        if ('messages' in patch) data.messages = plain(patch.messages);
        if ('memory' in patch) data.memory = plain(patch.memory);
        if ('updatedAt' in patch) data.updatedAt = new Date(patch.updatedAt);
        if ('messages' in patch || 'memory' in patch) Object.assign(data, listColumns({ ...current, ...patch }));
        return toChat(await tx.chatSession.update({ where: { id }, data }));
      });
    },

    update(id, patch) {
      return this.change(id, () => patch);
    },

    async remove(id) {
      if (!isUuid(id)) return false;
      const { count } = await prisma.chatSession.deleteMany({ where: { id, userId } });
      return count > 0;
    },

    /** Every conversation with its messages and memory, for this person's usage totals. */
    async everything() {
      const rows = await prisma.chatSession.findMany({ where: { userId }, select: { id: true, messages: true, memory: true, createdAt: true, updatedAt: true, title: true, workspace: true } });
      return rows.map(toChat);
    },
  };
}
