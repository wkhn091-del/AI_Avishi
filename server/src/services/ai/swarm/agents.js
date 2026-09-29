/**
 * The swarm's model calls: the micro-agents that write one file each (and fix it when the QA
 * compiler finds problems), and the reviewer, the QA compiler's model half.
 */
import { streamChat } from '../llmClient.js';
import { withTags } from '../usageMeter.js';
import { isLocal, languageOf, manifestsAbove, parseBlueprint, resolveImport, rootsOf } from './blueprint.js';

const TRUNCATED = /^(length|max_tokens|max_output_tokens)$/i;
const MAX_CONTINUATIONS = 2;
const REVIEW_BATCH_CHARS = 360_000;

export const BUILDER_RULES = `You are an expert compiler generating a single file of a larger project. Other agents are writing the other files at the same time from the same blueprint, so follow it exactly.
Output ONLY the raw, complete contents of the file: no Markdown fences, no explanations, nothing before or after the code.
- ZERO placeholders: no "TODO", no "// add logic here", no "...", no stubs, no mock data or fake logic standing in for what the spec asks for, no "not implemented". Write the complete, production-ready logic for this specific file based on the architect's spec.
- Exports: exactly the names and signatures the blueprint gives this file. Imports: only the project files and packages listed below, with their exact paths.
- Follow the shared contracts exactly: API paths and payloads, data shapes, event names, CSS class names, environment variables.
- Handle errors and edge cases; no debugging output.
- Your answer is limited to about 8,000 tokens: be complete and concise, without long comment blocks.`;

const CONTINUE_FILE = 'Your file was cut off by the output limit. Continue it exactly where it stopped: the next characters of the file, raw code only, nothing repeated, no fences or commentary.';

export const REVIEW_RULES = `You are the QA compiler of an AI engineering swarm. Agents wrote the files below in parallel from one blueprint; find what would break the build or the runtime, or leaves the spec unfinished:
- missing or wrong imports, unresolved variables or functions, wrong export names;
- "lazy" code: placeholders, stubs, empty or partial functions, fake data standing in for real logic, spec features that aren't implemented;
- syntax and type errors, wrong use of a library's API;
- contract mismatches between files: API paths and payloads, event names, props, CSS class names, environment variables.
Don't report style, naming, formatting or optional improvements. Report each defect once, on the file that must change, with the exact code that shows it.
Answer with ONE JSON object: {"issues":[{"path":"exact/file/path.js","line":12,"kind":"import|undefined|placeholder|incomplete|syntax|type|contract|logic","message":"what is wrong and exactly how to fix it","evidence":"the offending code, copied exactly from the file"}]}. Answer {"issues":[]} when nothing must be fixed.`;

/** A code fence longer than any run of backticks in the text, so the text can't close it. */
export function fenceFor(text) {
  const longest = Math.max(0, ...[...String(text).matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

const exportsText = (file) =>
  file.exports.length ? file.exports.map((item) => `  - ${item.name}${item.kind ? ` (${item.kind})` : ''}${item.signature ? `: ${item.signature}` : ''}`).join('\n') : '  (none)';

/** Everything one agent needs to write one file: the project, the contracts, and its neighbours' interfaces. */
export function fileBrief(blueprint, file) {
  const paths = new Set(blueprint.files.map((item) => item.path));
  const roots = rootsOf(blueprint);
  const byPath = new Map(blueprint.files.map((item) => [item.path, item]));
  const uses = file.imports
    .filter((item) => isLocal(item.from))
    .map((item) => {
      const other = byPath.get(resolveImport(file.path, item.from, paths, roots));
      return other ? `## "${item.from}" is ${other.path}\n${other.purpose}\nExports:\n${exportsText(other)}` : null;
    })
    .filter(Boolean);
  const usedBy = blueprint.files
    .filter((other) => other !== file)
    .flatMap((other) =>
      other.imports.filter((item) => isLocal(item.from) && resolveImport(other.path, item.from, paths, roots) === file.path).map((item) => `- ${other.path} imports ${item.names.length ? item.names.join(', ') : 'it'}`),
    );
  const packages = [
    ...new Set(manifestsAbove(file.path, blueprint.packages).flatMap((pkg) => [...Object.entries(pkg.dependencies), ...Object.entries(pkg.devDependencies)].map(([name, version]) => `${name}@${version}`))),
  ];
  return [
    `# Project: ${blueprint.title}\n${blueprint.summary}${blueprint.stack.length ? `\nStack: ${blueprint.stack.join(', ')}` : ''}`,
    `# Architecture\n${blueprint.architecture || '(see the contracts)'}`,
    `# Shared contracts\n${blueprint.contracts || '(none)'}`,
    `# File tree\n${[...blueprint.packages.map((pkg) => `- ${pkg.path}: package manifest (the server writes it)`), ...blueprint.files.map((item) => `- ${item.path}: ${item.purpose}`)].join('\n')}`,
    `# Packages this file may import\n${packages.length ? packages.join(', ') : '(none: only Node built-ins and project files)'}`,
    uses.length ? `# The project files this file imports, and what they export\n${uses.join('\n\n')}` : '',
    usedBy.length ? `# Files that import this one (keep what they use working)\n${usedBy.join('\n')}` : '',
    `# The file to write: ${file.path}\nLanguage: ${file.language}\nPurpose: ${file.purpose}\nExports:\n${exportsText(file)}\nImports:\n${
      file.imports.length ? file.imports.map((item) => `  - ${item.from}${item.names.length ? `: ${item.names.join(', ')}` : ''}`).join('\n') : '  (none)'
    }\n\nSpec:\n${file.spec}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function fixNote({ code, issues }) {
  const fence = fenceFor(code);
  const list = issues.map((issue) => `- ${issue.line ? `line ${issue.line}: ` : ''}[${issue.kind}] ${issue.message}`).join('\n');
  return `\n\n# Your previous version of this file\n${fence}\n${code}\n${fence}\n\n# What the QA compiler found (fix every item; keep everything else that works)\n${list}\n\nWrite the complete corrected file.`;
}

/** The code inside an answer that wrapped it in a fence anyway (with or without a sentence around it). */
export function stripFence(text) {
  const trimmed = String(text ?? '').replace(/^\uFEFF/, '').trim();
  const whole = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1\s*$/.exec(trimmed);
  if (whole) return whole[2];
  const blocks = [...trimmed.matchAll(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1[ \t]*$/gm)];
  const code = /^(import|export|const|let|var|function|class|async|'use|"use|<|\{|\[|\/\/|\/\*|#|@|:root|\*|\.|html|body)/;
  if (blocks.length === 1 && !code.test(trimmed)) return blocks[0][2];
  return trimmed;
}

/** A continuation joined to what came before it: fences dropped, a repeated overlap written once. */
function joinParts(previous, next) {
  const rest = next.replace(/^\s*(`{3,}|~{3,})[^\n]*\n/, '').replace(/\n?(`{3,}|~{3,})\s*$/, '');
  for (let size = Math.min(previous.length, rest.length, 400); size >= 12; size -= 1) {
    if (previous.endsWith(rest.slice(0, size))) return previous + rest.slice(size);
  }
  return previous + rest;
}

/** An edit's brief for one file: its current version and the architect's instructions (or just those, for a new file). */
function changeNote({ code, instructions }) {
  if (!code) return `\n\n# What the architect asks of this new file\n${instructions}\n`;
  const fence = fenceFor(code);
  return `\n\n# The current version of this file\n${fence}\n${code}\n${fence}\n\n# The change to make\n${instructions}\n\nWrite the complete updated file: make the change, and keep everything else as it is.`;
}

/**
 * One micro-agent writes (or, with `fix`, rewrites) one file. Tries the models in order; a file cut
 * off by the output limit is continued up to twice. Resolves to `{ code, model, truncated }`, or
 * `{ code: null, error }` when every model failed.
 */
export async function writeFile({ blueprint, file, models, maxTokens, signal, fix = null, change = null }) {
  const prompt = fileBrief(blueprint, file) + (fix ? fixNote(fix) : change ? changeNote(change) : '');
  let lastError = null;
  for (const who of models) {
    if (signal?.aborted) break;
    try {
      let text = '';
      let finish = null;
      for (let part = 0; part <= MAX_CONTINUATIONS; part += 1) {
        const messages = part
          ? [{ role: 'user', content: prompt }, { role: 'assistant', content: text }, { role: 'user', content: CONTINUE_FILE }]
          : [{ role: 'user', content: prompt }];
        const result = await withTags({ role: fix ? 'fix' : 'builder' }, () =>
          streamChat({ provider: who.provider, model: who.model, system: BUILDER_RULES, messages, params: { maxTokens, maxOutput: who.maxOutput, effort: 'low', temperature: 0.2 }, signal }),
        );
        text = part ? joinParts(text, result.text) : result.text;
        finish = result.finishReason;
        if (!TRUNCATED.test(finish ?? '')) break;
      }
      const code = stripFence(text);
      if (!code.trim()) throw new Error('The model returned an empty file.');
      return { code: code.endsWith('\n') ? code : `${code}\n`, model: who, truncated: TRUNCATED.test(finish ?? '') };
    } catch (error) {
      if (signal?.aborted) break;
      lastError = error;
      console.warn(`[swarm] ${file.path} with ${who.label} failed: ${error.log ?? error.message}`);
    }
  }
  return { code: null, error: lastError };
}

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

function reviewPrompt(blueprint, files, batch, notes) {
  const inBatch = new Set(batch);
  const others = blueprint.files.filter((file) => !inBatch.has(file.path) && files.has(file.path));
  const shown = batch.map((file) => {
    const code = files.get(file);
    const fence = fenceFor(code);
    return `## ${file}\n${fence}${languageOf(file)}\n${code}\n${fence}`;
  });
  return [
    `# Project: ${blueprint.title}\n${blueprint.summary}`,
    `# Shared contracts\n${blueprint.contracts || '(none)'}`,
    `# File tree\n${[...blueprint.packages.map((pkg) => `- ${pkg.path}: ${JSON.stringify({ dependencies: pkg.dependencies, devDependencies: pkg.devDependencies })}`), ...blueprint.files.map((file) => `- ${file.path}: ${file.purpose}`)].join('\n')}`,
    notes,
    others.length ? `# Other files (not shown here): what they export\n${others.map((file) => `- ${file.path}: ${file.exports.map((item) => item.name).join(', ') || '(no exports)'}`).join('\n')}` : '',
    `# The files to review\n\n${shown.join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The reviewer reads the files in `only` (in batches that fit its context) and returns their
 * defects. An issue must quote the code it's about, and a quote that isn't in the file is dropped:
 * the reviewer can't send a file back to be "fixed" for something it imagined.
 * @returns {Promise<{ issues: Map<string, Array<object>>, dropped: number, model: object|null, failed: boolean }>}
 */
export async function reviewFiles({ blueprint, files, only, models, signal, notes = '' }) {
  const targets = [...only].filter((file) => files.has(file) && !file.endsWith('package.json'));
  const batches = [];
  let batch = [];
  let size = 0;
  for (const file of targets) {
    const length = files.get(file).length;
    if (batch.length && size + length > REVIEW_BATCH_CHARS) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(file);
    size += length;
  }
  if (batch.length) batches.push(batch);

  const issues = new Map();
  let dropped = 0;
  let model = null;
  let failed = false;
  for (const files_ of batches) {
    const prompt = reviewPrompt(blueprint, files, files_, notes);
    let done = false;
    for (const who of models) {
      if (signal?.aborted) return { issues, dropped, model, failed };
      try {
        const result = await withTags({ role: 'qa' }, () =>
          streamChat({ provider: who.provider, model: who.model, system: REVIEW_RULES, messages: [{ role: 'user', content: prompt }], json: true, params: { maxTokens: 8_192, maxOutput: who.maxOutput, effort: 'medium' }, signal }),
        );
        const { data } = parseBlueprint(result.text.trim().startsWith('[') ? `{"issues":${result.text}}` : result.text);
        if (!data || !Array.isArray(data.issues)) throw new Error('The review is not the JSON that was asked for.');
        for (const raw of data.issues) {
          const file = typeof raw?.path === 'string' ? raw.path.trim().replace(/^\.\//, '') : '';
          const message = typeof raw?.message === 'string' ? raw.message.trim() : '';
          if (!files_.includes(file) || !message) {
            dropped += 1;
            continue;
          }
          const kind = typeof raw.kind === 'string' && raw.kind.trim() ? raw.kind.trim().toLowerCase() : 'logic';
          const code = files.get(file);
          const evidence = squash(raw.evidence);
          let line = Number.isInteger(raw.line) && raw.line > 0 ? raw.line : null;
          if (evidence.length >= 3) {
            if (!squash(code).includes(evidence)) {
              dropped += 1; // quoted code that isn't there: imagined
              continue;
            }
            const first = String(raw.evidence).split('\n').map((item) => item.trim()).find(Boolean);
            const index = code.split('\n').findIndex((item) => item.includes(first));
            if (index !== -1) line = index + 1;
          } else if (kind !== 'incomplete' && kind !== 'contract') {
            dropped += 1; // no evidence for a defect that has code to show
            continue;
          }
          const list = issues.get(file) ?? [];
          list.push({ source: 'review', kind, line, message: message.slice(0, 600) });
          issues.set(file, list);
        }
        model ??= who;
        done = true;
        break;
      } catch (error) {
        if (signal?.aborted) return { issues, dropped, model, failed };
        console.warn(`[swarm] Review with ${who.label} failed: ${error.log ?? error.message}`);
      }
    }
    if (!done) failed = true;
  }
  return { issues, dropped, model, failed };
}

export const TRIAGE_RULES = `A command failed while a generated project was built or tested in a sandbox. Decide which project files must change so it passes, and exactly how. When a test checks behavior the spec asks for, fix the implementation; fix the test only when it expects something the spec doesn't say. Change as few files as possible.
Answer with ONE JSON object: {"issues":[{"path":"exact/file/path.js","message":"what to change, specifically"}]}.`;

/**
 * The reviewer decides which files a failed sandbox step is about (a failing test names the test,
 * not the bug). Only paths of the project count.
 * @returns {Promise<Map<string, Array<{ message: string }>>|null>}
 */
export async function triageFailure({ blueprint, files, step, log, named, models, signal }) {
  const paths = new Set(files.keys());
  const byPath = new Map(blueprint.files.map((file) => [file.path, file]));
  const roots = rootsOf(blueprint);
  // The files the log names, and the project files they import: the likely places for the fix.
  const candidates = new Set(named);
  for (const file of named) {
    for (const item of byPath.get(file)?.imports ?? []) {
      const target = isLocal(item.from) ? resolveImport(file, item.from, paths, roots) : null;
      if (target) candidates.add(target);
    }
  }
  if (!candidates.size) for (const file of blueprint.files) candidates.add(file.path);
  let budget = 120_000;
  const shown = [];
  for (const file of candidates) {
    const code = files.get(file);
    if (!code || code.length > budget) continue;
    budget -= code.length;
    const fence = fenceFor(code);
    shown.push(`## ${file}\n${fence}${languageOf(file)}\n${code}\n${fence}`);
  }
  const prompt = [
    `# Project: ${blueprint.title}\n${blueprint.summary}`,
    `# Shared contracts\n${blueprint.contracts || '(none)'}`,
    `# File tree\n${blueprint.files.map((file) => `- ${file.path}: ${file.purpose}`).join('\n')}`,
    `# The command that failed${step.dir ? ` (in ${step.dir})` : ''}\n${step.command}`,
    `# Its output\n${fenceFor(log)}\n${log}\n${fenceFor(log)}`,
    `# The files most likely involved\n\n${shown.join('\n\n')}`,
  ].join('\n\n');
  for (const who of models) {
    if (signal?.aborted) return null;
    try {
      const result = await withTags({ role: 'qa' }, () =>
        streamChat({ provider: who.provider, model: who.model, system: TRIAGE_RULES, messages: [{ role: 'user', content: prompt }], json: true, params: { maxTokens: 4_096, maxOutput: who.maxOutput, effort: 'medium' }, signal }),
      );
      const { data } = parseBlueprint(result.text);
      if (!data || !Array.isArray(data.issues)) throw new Error('The triage is not the JSON that was asked for.');
      const decided = new Map();
      for (const raw of data.issues) {
        const file = typeof raw?.path === 'string' ? raw.path.trim().replace(/^\.\//, '') : '';
        const message = typeof raw?.message === 'string' ? raw.message.trim().slice(0, 600) : '';
        if (!paths.has(file) || file.endsWith('package.json') || !message) continue;
        decided.set(file, [...(decided.get(file) ?? []), { message }]);
      }
      return decided;
    } catch (error) {
      if (signal?.aborted) return null;
      console.warn(`[swarm] Triage with ${who.label} failed: ${error.log ?? error.message}`);
    }
  }
  return null;
}
