/**
 * Runs one chat turn: picks the model(s) for the workspace and mode, then runs
 * the effort level's strategy, streaming the answer through `emit`.
 *
 *   single            one call (Low, Medium)
 *   reflect           the model analyses the request and critiques its plan, then answers (High)
 *   reflect-critique  analysis and a draft, a self-critique of the draft, then the final answer (Extra)
 *   experts           several models answer at once (Promise.allSettled) and one merges
 *                     the answers into a single response (Max, and Brainstorm in the free workspace)
 *
 * Cost saving:
 *   - Handoff: after the first answer of a conversation, an expensive model is
 *     used only for planning and for the hardest requests (9–10); other
 *     follow-ups go to a cheap, high-output model (DeepSeek, Gemini Flash, GPT mini).
 *   - Auto-continue: when the final answer stops at the length limit, the
 *     partial answer goes back into the history with "Continue exactly where you
 *     left off" (to the cheap model when handoff is on), and the continuation
 *     streams on the same connection. The seam is cleaned: a repeated tail or a
 *     reopened code block is dropped, so the reader sees one continuous answer.
 *
 * Emergency mode sends everything to Claude Fable 5.1: no router, no handoff, no other model.
 */
import { config } from '../../config.js';
import { AiError, allFailed, completeText, isConfigured, modelOf, streamChat } from './llmClient.js';
import { EMERGENCY_MODEL, HANDOFF_MAX_COST, effortOf, freeProviders, premiumModel, teamFor } from './catalog.js';
import { providerById } from './providers.js';
import { CATEGORY_LABELS, KIND_LABELS, coolDown, pickFree, pickPremium, pickWorkhorse, rateRequest, wantsPipeline, webNeedOf } from './router.js';
import { withTags } from './usageMeter.js';
import { runSwarm } from './swarm/index.js';
import { memoryAvailable, recall } from '../memory/recall.js';
import { formatResearch, publicResearch, researchAvailable, searchWeb } from '../research/webSearch.js';

export const BASE_SYSTEM = `You are the AI assistant inside Stash, a personal workspace for software projects, GitHub repositories, links and files.
Answer in the language the user writes in (usually Hebrew). Be direct and practical.
Use Markdown when it helps, and put code in fenced code blocks with a language tag. When an answer contains several code files, put each file's path after the language on the opening fence (for example: \`\`\`jsx src/App.jsx) so the files can be packaged together.`;

export const CONTINUE_PROMPT = 'Continue exactly where you left off';
const CONTINUE_RULES = `Your previous answer was cut off by the length limit, and the reader must not notice the break. Continue it exactly where it stopped: begin with the very next characters, don't repeat anything already written, don't reopen a code block that is still open, and don't add any introduction or remark about continuing.`;
const REFLECT = `Before answering, think privately about the user's latest request. Write short notes: restate the real goal, list the key facts, constraints and pitfalls, outline the structure of the best answer, and critique that plan (what could be wrong or missing?). Do not write the final answer. Write the notes in the user's language.`;
const DRAFT = `Think privately about the user's latest request: note its goal, constraints and pitfalls, then write a complete first draft of the answer.`;
const CRITIQUE = `Review the draft you just wrote for the user's latest request. List concretely what is wrong, missing, unclear or could be better: correctness first, then completeness, then clarity. Do not rewrite the answer. Write in the user's language.`;
const synthesisPrompt = (hebrew) =>
  `Several expert models answered the user's latest request independently; their answers are below. Write ONE final answer${hebrew ? ' in Hebrew' : " in the user's language"}: combine their strongest points, resolve contradictions by choosing what is correct, and keep code complete and working (code, identifiers and paths stay as they are). Don't mention the experts or that there were several answers.`;

/** Finish reasons that mean "stopped at the length limit": OpenAI `length`, Anthropic `max_tokens`, Gemini `MAX_TOKENS`. */
const TEAM_LABEL = 'צוות פיתוח';

const TRUNCATED = /^(length|max_tokens|max_output_tokens)$/i;
const MASSIVE_MAX_TOKENS = 32_768;
const CONTINUATION_MAX_TOKENS = 32_768;
const RATE_LIMITED = new Set(['AI_RATE_LIMITED', 'AI_BUSY', 'AI_PAYMENT_REQUIRED']);

const targetOf = (provider, model, label, extra = {}) => ({ provider, model, label: label ?? `${providerById(provider).name} ${model}`, providerName: providerById(provider).name, ...extra });
const fromEntry = (entry) => targetOf(entry.provider, entry.model, entry.label, { id: entry.id, cost: entry.cost, maxOutput: entry.maxOutput, vision: entry.vision, video: entry.video });
const turnError = (message, code = 'AI_DISABLED') => new AiError(message, { code, log: message });
const needsOf = (media) => ({ vision: media.some((item) => item.kind === 'image'), video: media.some((item) => item.kind === 'video') });
const canTake = (target, needs) => (!needs.vision || target.vision) && (!needs.video || target.video);
const mediaNoun = (needs) => (needs.video ? 'וידאו' : 'תמונות');

// --- The seam between an answer and its continuation --------------------------------------

const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

/** Whether the text ends inside an open code block. */
export function insideCodeBlock(text) {
  let open = null;
  for (const line of String(text).split('\n')) {
    const match = FENCE.exec(line);
    if (!match) continue;
    if (!open) open = match[1];
    else if (match[1][0] === open[0] && match[1].length >= open.length && !match[2].trim()) open = null;
  }
  return Boolean(open);
}

/**
 * The start of a continuation, without what it repeats: a code fence reopened
 * inside an open block, and text that repeats the end of the previous part —
 * 16 characters or more, a restart of the unfinished last line, or two or more
 * whole lines. One repeated short line after a clean line end is kept, since
 * code can legitimately repeat a line (two `</li>` in a row).
 */
export function joinSeam(previous, next) {
  let head = String(next);
  if (insideCodeBlock(previous)) head = head.replace(/^\s*(?:`{3,}|~{3,})[^\n`]*\n/, '');
  const lastLine = previous.slice(previous.lastIndexOf('\n') + 1);
  for (let length = Math.min(head.length, previous.length, 600); length >= 1; length -= 1) {
    const overlap = head.slice(0, length);
    if (!previous.endsWith(overlap)) continue;
    const restartsLine = lastLine.trim() !== '' && length >= lastLine.length;
    const wholeLines = lastLine === '' && overlap.endsWith('\n') ? overlap.split('\n').length - 1 : 0;
    if (length >= 16 || restartsLine || wholeLines >= 2) return head.slice(length);
  }
  return head;
}

/** Holds back the first characters of a continuation until the seam can be judged, then streams the rest as it comes. */
export function seamCleaner(previous, write) {
  let buffer = '';
  let released = false;
  let written = '';
  const out = (text) => {
    if (!text) return;
    written += text;
    write(text);
  };
  const release = () => {
    released = true;
    out(joinSeam(previous, buffer));
    buffer = '';
  };
  return {
    push(text) {
      if (released) return out(text);
      buffer += text;
      if (buffer.length >= 640) release();
    },
    finish() {
      if (!released) release();
      return written;
    },
  };
}

const withoutMedia = (messages) => messages.map((message) => (message.media ? { role: message.role, content: message.content } : message));

// --- Choosing the model(s) ------------------------------------------------------------------

/** Which model(s) answer, and how. */
async function plan(request, text, { first, needs }) {
  const effort = effortOf(request.effort);
  let strategy = effort.strategy;
  let route;
  let target;
  let experts = null;
  let hebrewSynthesis = true;
  let massive = false;
  let rating = null;
  let handoffFrom = null;
  let team = null;
  const rate = async () => (rating ??= await rateRequest(text, { workspace: request.workspace }));
  const ratingInfo = () => ({
    complexity: rating.complexity,
    category: rating.category,
    categoryLabel: CATEGORY_LABELS[rating.category],
    kind: rating.kind,
    output: rating.output,
    reason: rating.reason,
    by: rating.by,
  });

  if (request.workspace === 'premium') {
    if (request.emergency) {
      const entry = premiumModel(EMERGENCY_MODEL);
      if (!isConfigured(entry.provider)) throw turnError('מצב חירום דורש מפתח של Anthropic (ANTHROPIC_API_KEY).');
      if (needs.video) throw turnError('Fable 5.1 לא מקבל וידאו. כבו את מצב החירום, ו-Gemini ינתח את הסרטון.', 'AI_BAD_REQUEST');
      target = fromEntry(entry);
      route = { mode: 'emergency', label: entry.label };
      if (strategy === 'experts') {
        strategy = 'reflect-critique';
        route.notice = 'במצב חירום רק Fable 5.1 עונה, ולכן המאמץ המקסימלי רץ כביקורת עצמית.';
      }
    } else if (request.premiumModel && request.premiumModel !== 'auto') {
      const entry = premiumModel(request.premiumModel);
      if (!entry) throw turnError('המודל שנבחר אינו מוכר.', 'AI_BAD_REQUEST');
      if (!isConfigured(entry.provider)) throw turnError(`המודל ${entry.label} דורש את המפתח ${providerById(entry.provider).keyEnv}.`);
      if (!canTake(entry, needs)) throw turnError(`${entry.label} לא מקבל ${mediaNoun(needs)}.`, 'AI_BAD_REQUEST');
      target = fromEntry(entry);
      route = { mode: 'manual', label: entry.label };
    } else {
      await rate();
      // A complex coding request goes to the development team: at the start of a project, or a new plan later.
      // Follow-ups (fixes, small changes) stay with one model, handed off to a cheap one as usual.
      // 'force' (internal only: the HTTP route sends true or false) lets the smoke test run the team on a small request.
      const wanted = request.pipeline === 'force' || (request.pipeline !== false && (first || rating.kind === 'planning') && wantsPipeline(rating, needs));
      team = wanted ? teamFor({ vision: needs.vision }) : null;
      if (team) {
        strategy = 'pipeline';
        target = fromEntry(team[0].models[0]);
        route = { mode: 'pipeline', label: TEAM_LABEL, tier: 'pipeline', ...ratingInfo() };
      } else {
        const pick = pickPremium(rating, needs);
        if (!pick) {
          throw turnError(needs.video ? 'וידאו נשלח רק ל-Gemini. הוסיפו GEMINI_API_KEY.' : needs.vision ? 'אין מודל פרימיום מוגדר שמקבל תמונות.' : 'בסביבת הפרימיום אין ספק מוגדר.');
        }
        target = fromEntry(pick.entry);
        massive = pick.tier === 'massiveCode';
        route = { mode: 'auto', label: pick.entry.label, tier: pick.tier, ...ratingInfo() };
      }
    }

    // Handoff: after the first answer, the expensive model is kept for planning and the hardest requests only.
    if (strategy !== 'pipeline' && !request.emergency && request.handoff !== false && !first && target.cost > HANDOFF_MAX_COST) {
      await rate();
      if (rating.kind !== 'planning' && rating.complexity < 9) {
        const cheaper = pickWorkhorse(needs);
        if (cheaper && cheaper.cost < target.cost) {
          route.handoff = { from: target.label, to: cheaper.label, reason: KIND_LABELS[rating.kind] ?? 'המשך' };
          handoffFrom = { provider: target.provider, model: target.model };
          if (!route.complexity) Object.assign(route, ratingInfo());
          target = fromEntry(cheaper);
          route.label = cheaper.label;
          massive ||= rating.output === 'massive';
        }
      }
    }

    if (strategy === 'experts') {
      const candidates = [target, ...['gpt-5.5', 'gemini-pro'].map(premiumModel).filter((entry) => isConfigured(entry.provider) && canTake(entry, needs)).map(fromEntry)];
      experts = candidates.filter((candidate, index) => candidates.findIndex((other) => other.provider === candidate.provider && other.model === candidate.model) === index);
    }
  } else {
    if (needs.vision || needs.video) throw turnError('צירוף תמונות ווידאו זמין בסביבת הפרימיום.', 'AI_BAD_REQUEST');
    if (request.freeMode === 'brainstorm') {
      strategy = 'experts';
      hebrewSynthesis = false;
      route = { mode: 'brainstorm' };
    } else if (request.freeMode === 'manual') {
      const provider = providerById(request.provider);
      if (!provider || provider.workspace !== 'free' || !isConfigured(provider.id)) throw turnError('הספק שנבחר אינו מוגדר בסביבה החינמית.', 'PROVIDER_NOT_CONFIGURED');
      target = targetOf(provider.id, request.model || modelOf(provider.id));
      route = { mode: 'manual', label: target.label };
    } else {
      await rate();
      const pick = pickFree(rating);
      if (!pick) throw turnError('בסביבה החינמית אין ספק מוגדר.');
      target = targetOf(pick.provider, pick.model);
      route = { mode: 'auto', label: target.label, ...ratingInfo() };
    }
    if (strategy === 'experts') {
      experts = freeProviders().map((provider) => targetOf(provider.id, modelOf(provider.id)));
      target ??= (() => {
        const pick = pickFree({ complexity: 8, category: 'reasoning' });
        return pick ? targetOf(pick.provider, pick.model) : experts[0];
      })();
      route.label ??= target.label;
    }
  }
  if (strategy === 'experts' && experts.length < 2) {
    strategy = 'reflect-critique';
    route.notice = 'שילוב מומחים דורש לפחות שני ספקים מוגדרים, ולכן הופעלה במקומו ביקורת עצמית.';
    experts = null;
  }
  return {
    effort,
    strategy,
    route: { ...route, provider: target.provider, providerName: target.providerName, model: target.model, strategy },
    target,
    experts,
    hebrewSynthesis,
    massive,
    handoffFrom,
    team,
    rating,
  };
}

// --- Context before the answer: the live web and long-term memory ---------------------------

/**
 * The web researcher and the long-term memory, run together before any model
 * writes: web results when the request needs current information (the router
 * decides; without a rating, the request's words do), and the memories that
 * apply to it. Both become blocks of the instructions that every model of the
 * turn gets, the team's architect included. Neither can fail the turn: a
 * failed search leaves a notice, and a memory problem is only logged.
 */
async function gatherContext({ request, lastUser, rating, signal, emit, route }) {
  const need = request.research !== false && researchAvailable() ? webNeedOf(rating, lastUser) : null;
  const [research, memory] = await Promise.all([
    need ? researchFor(need, { signal, emit, route }) : null,
    request.memory !== false && memoryAvailable() && request.userId
      ? // Only the signed-in person's memories. The free workspace matches words only, so it never pays for embeddings.
        withTags({ role: 'recall' }, () => recall(lastUser, { userId: request.userId, semantic: request.workspace === 'premium' })).catch((error) => {
          console.warn(`[memory] Recall failed: ${error.log ?? error.message}`);
          return null;
        })
      : null,
  ]);
  const blocks = [];
  if (memory?.items.length) {
    blocks.push(memory.block);
    emit({ type: 'recall', memories: memory.items });
  }
  if (research?.state === 'done' && research.results.length) blocks.push(formatResearch(research.found));
  return { blocks, research: research?.public ?? null, recalled: memory?.items.length ? memory.items : null };
}

async function researchFor(need, { signal, emit, route }) {
  emit({ type: 'research', research: { state: 'searching', provider: 'Tavily', query: need.query } });
  try {
    const found = await withTags({ role: 'research' }, () => searchWeb({ query: need.query, kind: need.kind, signal }));
    const shown = publicResearch(found);
    emit({ type: 'research', research: shown });
    return { state: 'done', results: found.results, found, public: shown };
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn(`[research] ${error.log ?? error.message}`);
    const failed = { state: 'failed', provider: 'Tavily', query: need.query, error: error.message };
    emit({ type: 'research', research: failed });
    route.notice = [route.notice, 'החיפוש ברשת נכשל, ולכן התשובה נכתבה בלי מידע עדכני.'].filter(Boolean).join(' ');
    return { state: 'failed', results: [], public: failed };
  }
}

// --- Running the turn -----------------------------------------------------------------------

/**
 * @param {object} turn
 * @param {object} turn.request   workspace, freeMode, provider, model, premiumModel, emergency, effort, handoff
 * @param {string} turn.system    instructions, project_state.md and any GitHub context
 * @param {Array<{role: string, content: string}>} turn.messages  the context window, ending with the user
 * @param {Array<object>} [turn.media]  the turn's attachments: { kind, mime, name, data | fileUri }
 * @param {boolean} [turn.first]  whether this is the conversation's first answer (no handoff yet)
 * @param {number} [turn.maxTokens]  a cap on the answer's length (the smoke test uses it to cut an answer off cheaply)
 */
export async function runTurn({ request, system, messages, media = [], first = true, signal, emit, maxTokens: cap, credits = null, user = null, edit = null, artifactId = null }) {
  const started = Date.now();
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  const needs = needsOf(media);
  const { effort, strategy, route, target, experts, hebrewSynthesis, massive, handoffFrom, team, rating } = await plan(request, lastUser, { first, needs });
  emit({ type: 'route', route });
  const context = await gatherContext({ request, lastUser, rating, signal, emit, route });
  if (context.blocks.length) system = `${system}\n\n${context.blocks.join('\n\n')}`;

  // The attachments travel with the latest user message only.
  const conversation = media.length
    ? messages.map((message, index) => (index === messages.length - 1 && message.role === 'user' ? { ...message, media } : message))
    : messages;
  const paramsFor = (who, maxTokens) => ({ effort: effort.native, maxTokens: cap ?? maxTokens ?? (massive ? MASSIVE_MAX_TOKENS : effort.maxTokens), maxOutput: who.maxOutput });
  const onRetry = (info) => emit({ type: 'retry', ...info });
  const usage = { input: 0, output: 0 };
  const count = (result) => {
    usage.input += result?.usage?.input ?? 0;
    usage.output += result?.usage?.output ?? 0;
  };

  // Every call is tagged for the cost meter; after a handoff, with the model it replaced.
  const stream = async (who, streamSystem, streamMessages, as = 'text', role = as === 'text' ? 'answer' : 'thinking', { onText, maxTokens } = {}) => {
    try {
      const result = await withTags({ role, insteadOf: handoffFrom ?? undefined }, () => streamChat({
        provider: who.provider,
        model: who.model,
        system: streamSystem,
        messages: streamMessages,
        params: paramsFor(who, maxTokens),
        signal,
        onRetry,
        onDelta: (delta) => {
          const kind = as === 'text' && delta.type === 'text' ? 'text' : 'reasoning';
          emit({ type: kind, text: delta.text });
          if (kind === 'text') onText?.(delta.text);
        },
      }));
      count(result);
      return result;
    } catch (error) {
      if (error instanceof AiError && RATE_LIMITED.has(error.code)) coolDown(who.provider);
      throw error;
    }
  };
  const heading = (label) => emit({ type: 'reasoning', text: `\n\n${label}\n` });

  // The final answer, continued automatically while it stops at the length limit.
  const continuations = [];
  const continuationTarget = (who) => {
    if (request.workspace !== 'premium' || request.emergency || request.handoff === false) return who;
    const cheaper = pickWorkhorse();
    return cheaper && cheaper.cost <= (who.cost ?? Infinity) ? fromEntry(cheaper) : who;
  };
  // continueWith picks who continues a cut-off answer; resumeFrom is text another model already streamed
  // for this answer, which is continued rather than rewritten; onText hears every streamed piece.
  const streamFinal = async (who, finalSystem, finalMessages, role = 'answer', { continueWith = continuationTarget, resumeFrom = null, onText, maxTokens } = {}) => {
    let result = resumeFrom === null ? await stream(who, finalSystem, finalMessages, 'text', role, { onText, maxTokens }) : { text: resumeFrom, finishReason: 'length' };
    let text = result.text;
    let rounds = 0;
    while (TRUNCATED.test(result.finishReason ?? '') && rounds < config.chat.autoContinueMax && !signal?.aborted) {
      rounds += 1;
      const next = continueWith(who);
      emit({ type: 'continue', round: rounds, provider: next.provider, providerName: next.providerName, model: next.model, label: next.label });
      const seam = seamCleaner(text, (chunk) => {
        emit({ type: 'text', text: chunk });
        onText?.(chunk);
      });
      try {
        const replaced = handoffFrom ?? (next === who ? undefined : { provider: who.provider, model: who.model });
        result = await withTags({ role: 'continuation', insteadOf: replaced }, () => streamChat({
          provider: next.provider,
          model: next.model,
          system: `${finalSystem}\n\n${CONTINUE_RULES}`,
          messages: [...withoutMedia(finalMessages), { role: 'assistant', content: text }, { role: 'user', content: CONTINUE_PROMPT }],
          params: { effort: 'low', maxTokens: CONTINUATION_MAX_TOKENS, maxOutput: next.maxOutput ?? 16_384 },
          signal,
          onRetry,
          onDelta: (delta) => {
            if (delta.type === 'text') seam.push(delta.text);
          },
        }));
        count(result);
        text += seam.finish();
        continuations.push({ round: rounds, provider: next.provider, providerName: next.providerName, model: next.model, label: next.label, ok: true });
      } catch (error) {
        text += seam.finish();
        if (signal?.aborted) throw error;
        continuations.push({ round: rounds, provider: next.provider, providerName: next.providerName, model: next.model, label: next.label, ok: false });
        if (error.code !== 'AI_EMPTY_ANSWER') {
          console.warn(`[ai] Auto-continue with ${next.label} failed: ${error.log ?? error.message}`);
          route.notice = 'ההמשך האוטומטי נכשל, ולכן התשובה נעצרה באמצע.';
        }
        return { ...result, text };
      }
    }
    if (rounds && TRUNCATED.test(result.finishReason ?? '')) route.notice = `התשובה ארוכה במיוחד ונעצרה אחרי ${rounds} המשכים אוטומטיים.`;
    return { ...result, text };
  };

  let final;
  let expertResults = null;
  let teamStatus = null;
  let artifact = null;
  if (strategy === 'single') {
    final = await streamFinal(target, system, conversation);
  } else if (strategy === 'reflect') {
    emit({ type: 'stage', stage: 'reflect', label: 'תכנון ובדיקה עצמית' });
    heading('תכנון ובדיקה עצמית:');
    const notes = await stream(target, `${system}\n\n${REFLECT}`, conversation, 'reasoning');
    emit({ type: 'stage', stage: 'answer', label: 'כתיבת התשובה' });
    final = await streamFinal(target, `${system}\n\n# Your private notes for this answer (don't repeat them verbatim)\n${notes.text}`, conversation);
  } else if (strategy === 'reflect-critique') {
    emit({ type: 'stage', stage: 'draft', label: 'טיוטה ראשונה' });
    heading('טיוטה ראשונה:');
    const draft = await stream(target, `${system}\n\n${DRAFT}`, conversation, 'reasoning');
    emit({ type: 'stage', stage: 'critique', label: 'ביקורת עצמית' });
    heading('ביקורת עצמית:');
    const critique = await stream(
      target,
      `${system}\n\n${CRITIQUE}`,
      [...withoutMedia(conversation), { role: 'assistant', content: draft.text }, { role: 'user', content: 'Review the draft above as instructed.' }],
      'reasoning',
    );
    emit({ type: 'stage', stage: 'answer', label: 'כתיבת התשובה המשופרת' });
    final = await streamFinal(
      target,
      `${system}\n\n# Your first draft\n${draft.text}\n\n# Your critique of it\n${critique.text}\n\nNow write the final, improved answer for the user. Don't mention the draft or the critique.`,
      conversation,
    );
  } else if (strategy === 'pipeline') {
    // A follow-up on a generated project edits it (edit), and a project's id names its live preview (artifactId).
    const work = await runSwarm({ team, system, conversation, emit, signal, route, effort: effort.native, toTarget: fromEntry, credits, user, edit, artifactId });
    final = { text: work.text };
    teamStatus = work.team;
    artifact = work.artifact ?? null;
  } else {
    emit({ type: 'stage', stage: 'experts', label: `${experts.length} מודלים עונים במקביל` });
    const settled = await Promise.allSettled(
      experts.map((expert) =>
        withTags({ role: 'expert' }, () => completeText({ provider: expert.provider, model: expert.model, system, messages: conversation, params: paramsFor(expert), onRetry })).then(
          (result) => {
            const done = { ...expert, ok: true, text: result.text, ms: result.ms };
            emit({ type: 'expert', expert: done });
            return done;
          },
          (error) => {
            if (error instanceof AiError && RATE_LIMITED.has(error.code)) coolDown(expert.provider);
            console.warn(`[ai] Expert ${expert.label} failed: ${error.log ?? error.message}`);
            const failed = { ...expert, ok: false, error: error.message, detail: error.detail ?? null, code: error.code ?? 'AI_FAILED' };
            emit({ type: 'expert', expert: failed });
            throw Object.assign(error, { failure: failed });
          },
        ),
      ),
    );
    expertResults = settled.map((outcome) => (outcome.status === 'fulfilled' ? outcome.value : outcome.reason.failure));
    const answered = expertResults.filter((expert) => expert.ok);
    if (!answered.length) {
      throw allFailed(expertResults.map((expert) => ({ provider: expert.provider, name: expert.label, message: expert.error, detail: expert.detail, code: expert.code })));
    }
    const answers = answered.map((expert, index) => `## Expert ${index + 1} (${expert.label})\n${expert.text}`).join('\n\n');
    const synthesizers = [target, ...answered.filter((expert) => expert.provider !== target.provider)];
    emit({ type: 'stage', stage: 'synthesis', label: `איחוד התשובות על ידי ${target.label}` });
    for (const synthesizer of synthesizers) {
      try {
        final = await streamFinal(synthesizer, `${system}\n\n${synthesisPrompt(hebrewSynthesis)}\n\n${answers}`, withoutMedia(conversation), 'synthesis');
        if (synthesizer !== target) route.notice = `האיחוד נעשה על ידי ${synthesizer.label}, כי ${target.label} לא הצליח.`;
        break;
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn(`[ai] Synthesis with ${synthesizer.label} failed: ${error.log ?? error.message}`);
      }
    }
    if (!final) {
      // Nobody could merge: the first expert's answer stands.
      const [best] = answered;
      emit({ type: 'text', text: best.text });
      route.notice = 'איחוד התשובות נכשל, ולכן מוצגת תשובת המומחה הראשון.';
      final = { text: best.text };
    }
  }

  return {
    text: final.text,
    usage: usage.output || usage.input ? usage : null,
    route,
    strategy,
    // A team answer is signed by the team, not by its first member.
    target: strategy === 'pipeline' ? { ...target, label: TEAM_LABEL } : target,
    experts: expertResults,
    team: teamStatus,
    artifact,
    research: context.research,
    recalled: context.recalled,
    continuations: continuations.length ? continuations : null,
    ms: Date.now() - started,
  };
}
