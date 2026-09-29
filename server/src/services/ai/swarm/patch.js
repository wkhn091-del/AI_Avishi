/**
 * Follow-ups on a generated project (the artifact's "what would you like to change?"): instead of a new project,
 * the architect plans a patch. It gets the current blueprint and as much of the code as fits, and answers with
 * the files that must change and how (modify, create or delete, each with its exports and imports after the
 * change) and any package.json that changes. The patch is applied to a copy of the blueprint, and the result
 * must pass the blueprint's own validation (every import resolves, every contract holds) before a single file is
 * rewritten; a patch that doesn't gets one repair round, then the next model.
 */
import { AiError, streamChat } from '../llmClient.js';
import { withTags } from '../usageMeter.js';
import { fenceFor } from './agents.js';
import { languageOf, parseBlueprint, validateBlueprint } from './blueprint.js';

const PATCH_TOKENS = 16_384;
const CODE_CHARS = 60_000;
const ACTIONS = new Set(['modify', 'create', 'delete']);
const MANIFEST = /(^|\/)package\.json$/;
const TRUNCATED = /^(length|max_tokens|max_output_tokens)$/i;
const abortError = () => Object.assign(new Error('The request was stopped.'), { name: 'AbortError' });

export function editRules({ maxFiles }) {
  return `You are the Master Architect of an AI engineering swarm. Agents built the project below from your blueprint, and the person now asks for a change. Plan it as a patch: the files that must change for the change to work end to end, and nothing else. You write NO code: an agent rewrites each file you list, seeing its current version, the blueprint and your instructions.

Return ONE JSON object and nothing else, in this shape:
{
  "summary": "what will change, 1-2 sentences, in the user's language",
  "changes": [{
    "path": "src/components/Board.jsx",
    "action": "modify",
    "purpose": "one line (required for a new file; give it when a file's role changes)",
    "instructions": "exactly what to change in this file: the components, functions, props, state, texts and styles, with names and values. Enough for an agent that sees only this file, the blueprint and these words",
    "exports": [{ "name": "Board", "kind": "component", "signature": "Board({ cells: Cell[], onPlay: (index: number) => void })" }],
    "imports": [{ "from": "./Cell.jsx", "names": ["Cell"] }],
    "spec": "for a new file: its complete technical spec"
  }],
  "packages": []
}

Rules:
- "action" is "modify" (the file exists), "create" (a new file) or "delete".
- Change as few files as the request allows, and keep every path, name and contract it doesn't touch.
- "exports" and "imports" are the file's complete lists after the change (copy the ones that stay). Give them for every modify and create.
- When an export is renamed, removed or its signature changes, every file that imports it is in "changes" too. When a file is deleted, every file that imports it is changed to stop.
- New files follow the blueprint's rules: text only, relative imports with the exact file name and extension, no path aliases, a path of letters, digits and - _ . @ + with an extension, at most ${maxFiles} files in the project.
- Never list a package.json in "changes": put the complete new entry of that package.json (the blueprint's shape) in "packages", with a version range for a new dependency (e.g. "^2.1.0"). Leave "packages" empty when no package.json changes.`;
}

/** The project as the architect sees it: the blueprint, and the code (as much as fits). */
export function projectContext(blueprint, files) {
  let budget = CODE_CHARS;
  const code = [];
  for (const file of blueprint.files) {
    const text = files.get(file.path);
    if (text === undefined) continue;
    if (text.length > budget) {
      code.push(`## ${file.path}\n(${text.split('\n').length} lines, not shown: rely on the blueprint)`);
      continue;
    }
    budget -= text.length;
    const fence = fenceFor(text);
    code.push(`## ${file.path}\n${fence}\n${text}\n${fence}`);
  }
  return `# The current blueprint\n\`\`\`json\n${JSON.stringify(blueprint)}\n\`\`\`\n\n# The current code\n${code.join('\n\n')}`;
}

/**
 * Checks a patch and applies it to a copy of the blueprint. Resolves to `{ patch, blueprint, errors }`: the patch
 * (summary, changes and the package.json files it changes) and the blueprint after it, or null and what's wrong.
 */
export function validatePatch(raw, blueprint, { maxFiles = 60 } = {}) {
  const none = (errors) => ({ patch: null, blueprint: null, errors });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return none(['Answer with one JSON object: { "summary", "changes", "packages" }.']);
  const errors = [];
  const existing = new Set(blueprint.files.map((file) => file.path));
  const changes = Array.isArray(raw.changes) ? raw.changes : [];
  const packages = (Array.isArray(raw.packages) ? raw.packages : []).filter((pkg) => pkg && typeof pkg === 'object');
  if (!changes.length && !packages.length) errors.push('"changes" is empty: list the files that must change.');
  const seen = new Set();
  const clean = [];
  for (const [index, change] of changes.entries()) {
    const where = `changes[${index}]`;
    const path = typeof change?.path === 'string' ? change.path.trim().replace(/^\.\//, '') : '';
    const action = ACTIONS.has(change?.action) ? change.action : null;
    const instructions = typeof change?.instructions === 'string' ? change.instructions.trim() : '';
    if (!path) errors.push(`${where}: "path" is missing.`);
    else if (!action) errors.push(`${where}: the "action" of ${path} must be "modify", "create" or "delete".`);
    else if (seen.has(path)) errors.push(`${where}: ${path} is listed twice.`);
    else if (MANIFEST.test(path)) errors.push(`${where}: ${path} is a package.json: put its complete new entry in "packages" instead.`);
    else if (action === 'modify' && !existing.has(path)) errors.push(`${where}: ${path} doesn't exist; use "create" for a new file.`);
    else if (action === 'delete' && !existing.has(path)) errors.push(`${where}: ${path} doesn't exist, so it can't be deleted.`);
    else if (action === 'create' && existing.has(path)) errors.push(`${where}: ${path} already exists; use "modify".`);
    else if (action !== 'delete' && !instructions) errors.push(`${where}: the "instructions" for ${path} are missing.`);
    else if (action === 'create' && !(typeof change.purpose === 'string' && change.purpose.trim())) errors.push(`${where}: the new file ${path} needs a "purpose".`);
    else clean.push({ ...change, path, action, instructions });
    if (path) seen.add(path);
  }
  for (const [index, pkg] of packages.entries()) if (typeof pkg.path !== 'string' || !MANIFEST.test(pkg.path)) errors.push(`packages[${index}]: "path" must be the path of a package.json.`);
  if (clean.length + packages.length > maxFiles) errors.push(`The patch changes more than ${maxFiles} files: split the request.`);
  if (errors.length) return none(errors);

  // Applied to a copy of the blueprint, the result must pass the blueprint's own checks.
  const next = structuredClone(blueprint);
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  for (const change of clean) {
    const index = next.files.findIndex((file) => file.path === change.path);
    if (change.action === 'delete') {
      next.files.splice(index, 1);
      continue;
    }
    const before = index === -1 ? null : next.files[index];
    const entry = {
      ...(before ?? {}),
      path: change.path,
      language: before?.language ?? (text(change.language) || languageOf(change.path)),
      purpose: text(change.purpose) || before?.purpose || '',
      exports: Array.isArray(change.exports) ? change.exports : (before?.exports ?? []),
      imports: Array.isArray(change.imports) ? change.imports : (before?.imports ?? []),
      // The spec follows the file, so the reviewer checks the new behavior, not the old one.
      spec: text(change.spec) || (before ? [before.spec, `Update: ${change.instructions}`].filter(Boolean).join('\n\n') : change.instructions),
    };
    if (index === -1) next.files.push(entry);
    else next.files[index] = entry;
  }
  for (const pkg of packages) {
    const index = next.packages.findIndex((item) => item.path === pkg.path);
    if (index === -1) next.packages.push(pkg);
    else next.packages[index] = { ...next.packages[index], ...pkg };
  }
  const checked = validateBlueprint(next, { maxFiles });
  if (!checked.blueprint) return none(checked.errors.map((error) => `After the patch, the blueprint has a problem: ${error}`));
  const purposeOf = (path) => checked.blueprint.files.find((file) => file.path === path)?.purpose ?? blueprint.files.find((file) => file.path === path)?.purpose ?? '';
  return {
    patch: {
      summary: text(raw.summary).slice(0, 600),
      changes: clean.map((change) => ({ path: change.path, action: change.action, purpose: purposeOf(change.path), instructions: change.instructions })),
      packages: packages.map((pkg) => pkg.path),
    },
    blueprint: checked.blueprint,
    errors: [],
  };
}

/** The architect's patch for `request`, with the blueprint after it. Throws an AiError when no model makes a valid one. */
export async function planPatch({ architects, system = '', request, blueprint, files, signal, effort, maxFiles, onNote = () => {} }) {
  const rules = `${editRules({ maxFiles })}\n\n${projectContext(blueprint, files)}${system ? `\n\n# About the conversation\n${system}` : ''}`;
  const messages = [{ role: 'user', content: request }];
  const check = (text) => {
    const parsed = parseBlueprint(text);
    return parsed.data ? validatePatch(parsed.data, blueprint, { maxFiles }) : { patch: null, blueprint: null, errors: [parsed.error] };
  };
  const failures = [];
  for (const [index, who] of architects.entries()) {
    if (signal?.aborted) break;
    if (index > 0) onNote(`${architects[index - 1].label} נכשל, ולכן ${who.label} מתכנן את השינוי`, who);
    const call = (history) =>
      withTags({ role: 'architect' }, () =>
        streamChat({ provider: who.provider, model: who.model, system: rules, messages: history, json: true, params: { maxTokens: PATCH_TOKENS, maxOutput: who.maxOutput, effort: effort ?? 'medium' }, signal }),
      );
    try {
      let result = await call(messages);
      let checked = check(result.text);
      let repaired = false;
      if (!checked.patch) {
        onNote(`מתקן ${checked.errors.length === 1 ? 'בעיה אחת' : `${checked.errors.length} בעיות`} בתוכנית השינויים`);
        const cut = TRUNCATED.test(result.finishReason ?? '') ? 'Your patch was cut off by the output limit: write shorter instructions.\n\n' : '';
        result = await call([
          ...messages,
          { role: 'assistant', content: result.text.slice(0, 60_000) || '{}' },
          { role: 'user', content: `${cut}The patch has these problems:\n${checked.errors.map((error) => `- ${error}`).join('\n')}\n\nReturn the complete corrected patch as one JSON object.` },
        ]);
        checked = check(result.text);
        repaired = true;
      }
      if (checked.patch) return { patch: checked.patch, blueprint: checked.blueprint, model: who, repaired, fellBack: index > 0 };
      failures.push(`${who.label}: ${checked.errors.slice(0, 3).join(' ')}`);
    } catch (error) {
      if (signal?.aborted) break;
      failures.push(`${who.label}: ${error.log ?? error.message}`);
      console.warn(`[swarm] Patch with ${who.label} failed: ${error.log ?? error.message}`);
    }
  }
  if (signal?.aborted) throw abortError();
  throw new AiError('הארכיטקט לא הצליח לתכנן את השינוי. נסו לנסח את הבקשה אחרת, או לפצל אותה לשינויים קטנים יותר.', {
    code: 'AI_PATCH_FAILED',
    log: `No valid patch: ${failures.join(' | ')}`,
    detail: failures.join('\n'),
  });
}
