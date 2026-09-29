/**
 * A generated project's versions (an artifact), kept in its conversation. The development team's answer is
 * version 1: its files are the answer's code blocks (as its ZIP is built), and its blueprint is on
 * `message.artifact`. Each edit is an answer with the next version: the files it changed, as code blocks, and
 * the ones it deleted. A version's files are the replay of the versions up to it.
 */
import { extractCodeFiles } from './codeBundles.js';

const REPORT = 'QA_REPORT.md';

/** The artifact `id` at `version` (the latest by default): `{ id, version, latest, blueprint, files, messageId, summary }`, or null. */
export function artifactState(messages, id, version = null) {
  let state = null;
  let latest = 0;
  for (const message of messages ?? []) {
    const artifact = message.role === 'assistant' && !message.error ? message.artifact : null;
    if (!artifact || artifact.id !== id) continue;
    latest = Math.max(latest, artifact.version);
    if ((version && artifact.version > version) || (state && artifact.version <= state.version)) continue;
    const files = new Map(artifact.version > 1 && state ? state.files : []);
    const changed = artifact.version > 1 ? new Set(artifact.changed ?? []) : null;
    for (const file of extractCodeFiles(message.content)) if (!changed || changed.has(file.path)) files.set(file.path, file.content);
    for (const path of artifact.deleted ?? []) files.delete(path);
    files.delete(REPORT);
    state = { id, version: artifact.version, blueprint: artifact.blueprint, files, messageId: message.id, summary: artifact.summary ?? artifact.blueprint?.summary ?? '' };
  }
  return state && { ...state, latest };
}
