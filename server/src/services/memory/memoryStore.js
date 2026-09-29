/**
 * The long-term memory: short facts about how a person works, learned from their conversations or
 * added by them, in the memories table (PostgreSQL). Every function takes the person's user id and
 * filters by it, down to single-row updates and deletes: another person's memory reads as missing.
 */
import { Prisma } from '@prisma/client';
import { db } from '../../lib/db.js';
import { isUuid } from '../../lib/ids.js';
import { embed, embedder, embedderId, vectorBytes, vectorFromBytes } from './embeddings.js';

export const MEMORY_KINDS = Object.freeze(['preference', 'style', 'rule', 'fact']);
export const CONTENT_MAX = 300;
export const PROJECT_MAX = 100;

const iso = (date) => (date ? date.toISOString() : null);

const publicOf = (row) => ({
  id: row.id,
  kind: row.kind,
  content: row.content,
  project: row.project ?? null,
  source: row.source,
  conversationId: row.chatSessionId ?? null,
  confirmations: row.confirmations,
  uses: row.uses,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
  lastUsedAt: iso(row.lastUsedAt),
});

/** A person's memories, most recently changed first; `withVectors` adds each one's vector and the model that made it. */
export async function listMemories(userId, { withVectors = false } = {}) {
  const rows = await db().memory.findMany({ where: { userId }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] });
  return rows.map((row) =>
    withVectors ? { ...publicOf(row), vector: row.embedding ? vectorFromBytes(row.embedding) : null, vectorModel: row.embeddingModel ?? null } : publicOf(row),
  );
}

export const countMemories = (userId) => db().memory.count({ where: { userId } });

/**
 * The vector for a text: `{ embedding, embeddingModel, vector }`, or nulls without an embedding
 * provider or when it fails (the memory is kept anyway, and gets its vector later: backfillVectors).
 */
export async function vectorFor(content, who = embedder()) {
  if (!who) return { embedding: null, embeddingModel: null, vector: null };
  try {
    const [vector] = await embed([content], 'document', who);
    return { embedding: vectorBytes(vector), embeddingModel: embedderId(who), vector };
  } catch (error) {
    console.warn(`[memory] Embedding failed: ${error.log ?? error.message}`);
    return { embedding: null, embeddingModel: null, vector: null };
  }
}

export async function addMemory(userId, { kind, content, project = null, source, conversationId = null, stored }) {
  const { embedding, embeddingModel } = stored ?? (await vectorFor(content));
  const now = new Date();
  const data = { userId, kind, content, project, source, chatSessionId: isUuid(conversationId) ? conversationId : null, embedding, embeddingModel, createdAt: now, updatedAt: now };
  try {
    return publicOf(await db().memory.create({ data }));
  } catch (error) {
    // The conversation it came from was deleted meanwhile: keep the memory without the link.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') || !data.chatSessionId) throw error;
    return publicOf(await db().memory.create({ data: { ...data, chatSessionId: null } }));
  }
}

/** Edits one of the person's memories; a new text gets a new vector. Null when it isn't theirs (or doesn't exist). */
export async function updateMemory(userId, id, { content, kind, project }, { confirm = false } = {}) {
  if (!isUuid(id)) return null;
  const data = { updatedAt: new Date() };
  if (content !== undefined) {
    const { embedding, embeddingModel } = await vectorFor(content);
    Object.assign(data, { content, embedding, embeddingModel });
  }
  if (kind !== undefined) data.kind = kind;
  if (project !== undefined) data.project = project;
  if (confirm) data.confirmations = { increment: 1 };
  const { count } = await db().memory.updateMany({ where: { id, userId }, data });
  return count ? publicOf(await db().memory.findUnique({ where: { id } })) : null;
}

/** The same fact was learned again: it counts as more certain, and moves to the top. */
export async function confirmMemory(userId, id) {
  await db().memory.updateMany({ where: { id, userId }, data: { confirmations: { increment: 1 }, updatedAt: new Date() } });
}

export async function removeMemory(userId, id) {
  if (!isUuid(id)) return false;
  const { count } = await db().memory.deleteMany({ where: { id, userId } });
  return count > 0;
}

export async function clearMemories(userId) {
  const { count } = await db().memory.deleteMany({ where: { userId } });
  return count;
}

/** Memories that were just given to a model (this doesn't move them in the list). */
export async function markUsed(userId, ids) {
  if (!ids.length) return;
  await db().memory.updateMany({ where: { userId, id: { in: ids } }, data: { uses: { increment: 1 }, lastUsedAt: new Date() } });
}

/**
 * Memories saved without a vector, or with one from another model (after a key was added or
 * MEMORY_EMBEDDINGS changed), get one now: up to `limit` per call.
 */
export async function backfillVectors(userId, memories, { limit = 32, who = embedder() } = {}) {
  if (!who) return 0;
  const id = embedderId(who);
  const missing = memories.filter((memory) => memory.vectorModel !== id).slice(0, limit);
  if (!missing.length) return 0;
  const vectors = await embed(
    missing.map((memory) => memory.content),
    'document',
    who,
  );
  for (const [index, memory] of missing.entries()) {
    await db().memory.updateMany({ where: { id: memory.id, userId }, data: { embedding: vectorBytes(vectors[index]), embeddingModel: id } });
    Object.assign(memory, { vector: vectors[index], vectorModel: id });
  }
  return missing.length;
}
