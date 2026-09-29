/**
 * A tiny JSON-file document store with one file per database.
 *
 * Good fit for a single-user local dashboard: zero setup, human-readable,
 * trivially backed up. Writes are serialised through a promise chain and
 * committed atomically (write temp file, then rename), so a crash mid-write
 * can't leave a half-written database behind.
 *
 * Swap this module for SQLite/Postgres later without touching the routes:
 * they only use list/get/insert/update/remove.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const COLLECTIONS = ['projects', 'links', 'files', 'explanations', 'repos', 'chats', 'media', 'bundles', 'attachments'];

export class JsonStore {
  #file;
  #data = null;
  #writeChain = Promise.resolve();

  /** @param {string} file Absolute path of the JSON database file. */
  constructor(file) {
    this.#file = file;
  }

  /** Loads the database from disk, creating an empty one on first run. */
  async init() {
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    let parsed = {};
    try {
      parsed = JSON.parse(await fs.readFile(this.#file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Never silently replace a database we failed to read — that would wipe data.
        throw new Error(`Could not read ${this.#file}: ${error.message}. Fix or move the file and restart.`);
      }
    }
    this.#data = Object.fromEntries(
      COLLECTIONS.map((name) => [name, Array.isArray(parsed[name]) ? parsed[name] : []]),
    );
    await this.#persist();
  }

  /** All documents in a collection, newest first. Returns copies. */
  list(collection) {
    return structuredClone(this.#collection(collection));
  }

  /** One document by id (a copy), or null. */
  get(collection, id) {
    const found = this.#collection(collection).find((item) => item.id === id);
    return found ? structuredClone(found) : null;
  }

  /** Inserts one document or an array of documents at the front of a collection. */
  async insert(collection, docs) {
    const items = Array.isArray(docs) ? docs : [docs];
    this.#collection(collection).unshift(...structuredClone(items));
    await this.#persist();
    return docs;
  }

  /** Shallow-merges `patch` into a document. Returns the updated copy, or null. */
  async update(collection, id, patch) {
    const items = this.#collection(collection);
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return null;
    items[index] = { ...items[index], ...structuredClone(patch), id };
    await this.#persist();
    return structuredClone(items[index]);
  }

  /** Removes a document. Returns the removed document, or null. */
  async remove(collection, id) {
    const items = this.#collection(collection);
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const [removed] = items.splice(index, 1);
    await this.#persist();
    return removed;
  }

  /** Resolves once every queued write has hit the disk (used on shutdown). */
  flush() {
    return this.#writeChain;
  }

  #collection(name) {
    if (!this.#data) throw new Error('JsonStore used before init()');
    if (!COLLECTIONS.includes(name)) throw new Error(`Unknown collection "${name}"`);
    return this.#data[name];
  }

  #persist() {
    // Snapshot now so each queued write reflects the state at the time of the call.
    const snapshot = JSON.stringify(this.#data, null, 2);
    const write = async () => {
      const temp = `${this.#file}.${process.pid}.tmp`;
      await fs.writeFile(temp, snapshot, 'utf8');
      await fs.rename(temp, this.#file);
    };
    // Run after the previous write whether it succeeded or failed, so one
    // failed write can't wedge the queue; the caller still sees its own error.
    const pending = this.#writeChain.then(write, write);
    this.#writeChain = pending.catch(() => {});
    return pending;
  }
}
