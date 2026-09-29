import { useCallback, useEffect, useRef, useState } from 'react';
import { request, streamJsonLines, uploadWithProgress } from '../../lib/api.js';
import { useCredits } from '../credits/CreditsProvider.jsx';

const SETTINGS_KEY = 'stash.chat.workspace';
const DEFAULTS = { workspace: null, premiumModel: 'auto', emergency: false, effort: 'medium', freeMode: 'auto', freeProvider: null, freeModel: null, handoff: null, pipeline: null, research: null, memory: null };
const MB = 1024 * 1024;

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

const dropTrailingAnswers = (messages) => {
  const copy = [...messages];
  while (copy.length && copy.at(-1).role === 'assistant') copy.pop();
  return copy;
};

/**
 * The AI workspace: the catalog (both workspaces, premium models, efforts), the
 * conversations, the open conversation with its memory, and the answer being
 * written. Lives in the Dashboard, so an answer keeps streaming while another
 * tab is open. `onSelect(id)` puts the open conversation in the URL.
 */
export function useChat({ onSelect }) {
  const credits = useCredits();
  const [catalog, setCatalog] = useState({ status: 'loading', data: null, error: null });
  const [list, setList] = useState({ status: 'loading', items: [], error: null });

  /** A conversation's new token and cost totals, in its header and in the list. */
  const showUsage = (conversationId, usage) => {
    setThread((current) => (current.id === conversationId ? { ...current, usage } : current));
    setList((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === conversationId ? { ...item, cost: usage.cost, tokens: usage.input + usage.output } : item)),
    }));
  };
  const [activeId, setActiveId] = useState(null);
  const [thread, setThread] = useState({ id: null, status: 'idle', messages: [], memory: null, error: null });
  const [live, setLive] = useState(null);
  const [memoryStatus, setMemoryStatus] = useState({ state: 'idle', message: null });
  const [settings, setSettings] = useState(loadSettings);
  const [attachments, setAttachments] = useState([]);
  const [tool, setTool] = useState(null); // 'image' | 'video' | 'music': the composer's generator
  const [mediaLive, setMediaLive] = useState(null);
  const mediaAbort = useRef(null);
  const attachmentsRef = useRef(attachments);
  const threadRef = useRef(thread);
  const liveRef = useRef(live);
  const controller = useRef(null);
  const pending = useRef({ text: '', reasoning: '' });
  const frame = useRef(0);

  useEffect(() => {
    threadRef.current = thread;
  }, [thread]);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // storage may be unavailable; the settings still apply
    }
  }, [settings]);

  const loadCatalog = useCallback(async () => {
    setCatalog((current) => ({ ...current, status: current.data ? 'ready' : 'loading', error: null }));
    try {
      setCatalog({ status: 'ready', data: await request('/chat/catalog'), error: null });
    } catch (error) {
      setCatalog({ status: 'error', data: null, error: error.message });
    }
  }, []);

  const loadList = useCallback(async () => {
    try {
      const { conversations } = await request('/chat/conversations');
      setList({ status: 'ready', items: conversations, error: null });
    } catch (error) {
      setList((current) => ({ ...current, status: 'error', error: error.message }));
    }
  }, []);

  useEffect(() => {
    loadCatalog();
    loadList();
  }, [loadCatalog, loadList]);

  useEffect(() => {
    setMemoryStatus({ state: 'idle', message: null });
    if (!activeId) {
      if (!liveRef.current) setThread({ id: null, status: 'idle', messages: [], memory: null, error: null });
      return undefined;
    }
    if (threadRef.current.id === activeId && threadRef.current.status === 'ready') return undefined;
    const abort = new AbortController();
    setThread({ id: activeId, status: 'loading', messages: [], memory: null, error: null });
    request(`/chat/conversations/${activeId}`, { signal: abort.signal }).then(
      ({ conversation }) => setThread({ id: activeId, status: 'ready', messages: conversation.messages, memory: conversation.memory, usage: conversation.usage, error: null }),
      (error) => {
        if (error.name !== 'AbortError') setThread({ id: activeId, status: 'error', messages: [], memory: null, error: error.message });
      },
    );
    return () => abort.abort();
  }, [activeId]);

  const data = catalog.data;
  const workspace = settings.workspace ?? (data && !data.premium.available && data.free.available ? 'free' : 'premium');
  const freeProvider = data?.free.providers.find((provider) => provider.id === settings.freeProvider) ?? data?.free.providers[0] ?? null;
  const freeModel = settings.freeMode === 'manual' && freeProvider && settings.freeProvider === freeProvider.id && settings.freeModel ? settings.freeModel : (freeProvider?.defaultModel ?? null);

  const update = (changes) => setSettings((current) => ({ ...current, ...changes }));
  // The cost-saving handoff: on unless the person turned it off (or the server's CHAT_HANDOFF=off).
  const handoff = (data?.premium.handoff.default ?? true) && settings.handoff !== false;
  // The development team for complex coding requests: on unless the person turned it off (or PIPELINE=off).
  const pipeline = (data?.premium.pipeline?.default ?? true) && settings.pipeline !== false;
  // Web research (needs a Tavily key on the server) and the long-term memory: on unless turned off.
  const research = Boolean(data?.research?.available) && settings.research !== false;
  const memory = Boolean(data?.longTermMemory?.available) && settings.memory !== false;

  const patchAttachment = (localId, changes) => setAttachments((current) => current.map((item) => (item.localId === localId ? { ...item, ...changes } : item)));

  /** Uploads images and videos for the next message; returns the problems with files that were refused. */
  const addFiles = useCallback(
    (files) => {
      const limits = data?.attachments ?? { imageMaxMb: 5, videoMaxMb: 100 };
      const problems = [];
      for (const file of [...files]) {
        const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : null;
        if (!kind) {
          problems.push(`${file.name}: אפשר לצרף רק תמונות או וידאו.`);
          continue;
        }
        const maxMb = kind === 'image' ? limits.imageMaxMb : limits.videoMaxMb;
        if (file.size > maxMb * MB) {
          problems.push(kind === 'image' ? `${file.name}: תמונה יכולה להיות עד ${maxMb}MB.` : `${file.name}: וידאו יכול להיות עד ${maxMb}MB.`);
          continue;
        }
        const localId = `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const abort = new AbortController();
        const preview = kind === 'image' ? URL.createObjectURL(file) : null;
        setAttachments((current) => [...current, { localId, name: file.name, kind, size: file.size, preview, status: 'uploading', progress: 0, abort }]);
        const form = new FormData();
        form.append('file', file);
        uploadWithProgress('/chat/attachments', form, { signal: abort.signal, onProgress: (progress) => patchAttachment(localId, { progress }) }).then(
          ({ attachment }) => patchAttachment(localId, { status: 'ready', progress: 1, id: attachment.id, url: attachment.url }),
          (error) => {
            if (error.name !== 'AbortError') patchAttachment(localId, { status: 'error', error: error.message });
          },
        );
      }
      return problems;
    },
    [data],
  );

  const removeAttachment = (localId) => {
    const item = attachmentsRef.current.find((candidate) => candidate.localId === localId);
    if (!item) return;
    item.abort?.abort();
    if (item.id) request(`/chat/attachments/${item.id}`, { method: 'DELETE' }).catch(() => {});
    if (item.preview) URL.revokeObjectURL(item.preview);
    setAttachments((current) => current.filter((candidate) => candidate.localId !== localId));
  };

  const flush = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const { text, reasoning } = pending.current;
    if (!text && !reasoning) return;
    pending.current = { text: '', reasoning: '' };
    setLive((current) => (current ? { ...current, text: current.text + text, reasoning: current.reasoning + reasoning, retry: null } : current));
  };

  const touchList = (conversationId, changes) =>
    setList((current) => {
      const items = current.items.map((item) => (item.id === conversationId ? { ...item, ...changes } : item));
      items.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      return { ...current, items };
    });

  /** Sends a message (or asks again for the last one) and streams the answer. */
  const send = useCallback(
    async ({ content = '', regenerate = false, artifact = null } = {}) => {
      if (!data || liveRef.current || mediaAbort.current) return;
      let conversationId = activeId;
      if (!conversationId) {
        const { conversation } = await request('/chat/conversations', { method: 'POST', body: {} });
        conversationId = conversation.id;
        setList((current) => ({ ...current, items: [conversation, ...current.items] }));
        const fresh = { id: conversationId, status: 'ready', messages: [], memory: conversation.memory, error: null };
        threadRef.current = fresh;
        setThread(fresh);
        setActiveId(conversationId);
        onSelect(conversationId);
      }
      const localId = `local-${Date.now()}`;
      // A follow-up from a project's panel edits that project (artifact: its id); the composer's attachments stay put.
      const sent = regenerate || artifact ? [] : attachmentsRef.current.filter((item) => item.status === 'ready');
      const shown = sent.map((item) => ({ id: item.id, name: item.name, kind: item.kind, size: item.size, url: item.url }));
      setThread((current) => ({
        ...current,
        messages: regenerate
          ? dropTrailingAnswers(current.messages)
          : [...current.messages, { id: localId, role: 'user', content, createdAt: new Date().toISOString(), ...(shown.length ? { attachments: shown } : {}), ...(artifact ? { artifact: { id: artifact } } : {}) }],
      }));
      if (sent.length) {
        for (const item of sent) if (item.preview) URL.revokeObjectURL(item.preview);
        setAttachments((current) => current.filter((item) => !sent.includes(item)));
      }
      const abort = new AbortController();
      controller.current = abort;
      pending.current = { text: '', reasoning: '' };
      setMemoryStatus({ state: 'idle', message: null });
      setLive({ conversationId, id: null, text: '', reasoning: '', retry: null, route: null, stage: null, experts: [], continuations: [], team: null, research: null, recalled: null, started: Date.now(), workspace, effort: settings.effort });

      const body =
        workspace === 'premium'
          ? { content, regenerate, workspace, effort: settings.effort, premiumModel: settings.premiumModel, emergency: settings.emergency, handoff, pipeline, research, memory, attachments: sent.map((item) => item.id), ...(artifact ? { artifact: { id: artifact } } : {}) }
          : { content, regenerate, workspace, effort: settings.effort, freeMode: settings.freeMode, provider: freeProvider?.id, model: freeModel, research, memory };

      const finish = (message) => {
        flush();
        setThread((current) => (current.id === conversationId ? { ...current, messages: [...current.messages, message] } : current));
        setLive(null);
        touchList(conversationId, { updatedAt: new Date().toISOString() });
      };
      try {
        await streamJsonLines(`/chat/conversations/${conversationId}/messages`, body, {
          signal: abort.signal,
          onEvent: (event) => {
            switch (event.type) {
              case 'start':
                if (event.userMessage) {
                  setThread((current) => ({ ...current, messages: current.messages.map((message) => (message.id === localId ? event.userMessage : message)) }));
                }
                if (event.title) touchList(conversationId, { title: event.title, updatedAt: new Date().toISOString() });
                setLive((current) => current && { ...current, id: event.assistantId });
                break;
              case 'context':
                setThread((current) => {
                  const messages = [...current.messages];
                  const index = messages.findLastIndex((message) => message.role === 'user');
                  if (index !== -1) messages[index] = { ...messages[index], context: { github: event.github } };
                  return { ...current, messages };
                });
                break;
              case 'route':
                setLive((current) => current && { ...current, route: event.route });
                break;
              case 'stage':
                setLive((current) => current && { ...current, stage: { stage: event.stage, label: event.label } });
                break;
              case 'team':
                setLive((current) => current && { ...current, team: event.team });
                break;
              case 'pipeline':
                // A development-team run: its dashboard listens to the run's live events (useSwarmPipeline).
                setLive((current) => current && { ...current, pipeline: { runId: event.runId, live: true } });
                break;
              case 'research':
                setLive((current) => current && { ...current, research: event.research });
                break;
              case 'recall':
                setLive((current) => current && { ...current, recalled: event.memories });
                break;
              case 'usage':
                // The running cost, after every model call of the answer being written.
                showUsage(conversationId, event.conversationUsage);
                break;
              case 'retry':
                setLive((current) => current && { ...current, retry: { attempt: event.attempt, attempts: event.attempts, waitMs: event.waitMs, at: Date.now() } });
                break;
              case 'expert':
                setLive((current) => current && { ...current, experts: [...current.experts, event.expert] });
                break;
              case 'continue':
                setLive((current) => current && { ...current, continuations: [...current.continuations, event] });
                break;
              case 'text':
              case 'reasoning':
                pending.current[event.type] += event.text;
                if (!frame.current) frame.current = requestAnimationFrame(flush);
                break;
              case 'done':
              case 'error':
                finish(event.message);
                if (event.conversationUsage) showUsage(conversationId, event.conversationUsage);
                // The balance after the answer's charge; an answer stopped for credits opens the dialog.
                credits.update(event.credits);
                if (event.type === 'error') credits.handleError(event.message?.error);
                break;
              case 'memory':
                setMemoryStatus({ state: event.status, message: event.message ?? null });
                if (event.status === 'updated') {
                  setThread((current) => (current.id === conversationId ? { ...current, memory: event.memory } : current));
                  if (event.conversationUsage) showUsage(conversationId, event.conversationUsage);
                }
                break;
              default:
            }
          },
        });
      } catch (error) {
        flush();
        const current = liveRef.current;
        if (!current) return; // the answer had already finished (e.g. the connection dropped during compaction)
        const partial = {
          id: current.id ?? `local-answer-${Date.now()}`,
          role: 'assistant',
          content: current.text,
          reasoning: current.reasoning || undefined,
          route: current.route ?? undefined,
          experts: current.experts.length ? current.experts : undefined,
          team: current.team ?? undefined,
          research: current.research ?? undefined,
          recalled: current.recalled ?? undefined,
          label: current.route?.label,
          providerName: current.route?.providerName,
          model: current.route?.model,
          effort: current.effort,
          createdAt: new Date().toISOString(),
        };
        credits.handleError(error); // a 402: out of credits before anything ran
        if (error.name === 'AbortError') finish({ ...partial, stopped: true });
        else finish({ ...partial, error: { message: error.message, detail: error.details?.detail ?? null } });
      } finally {
        controller.current = null;
      }
    },
    [data, activeId, workspace, settings.effort, settings.premiumModel, settings.emergency, settings.freeMode, freeProvider, freeModel, handoff, pipeline, research, memory, onSelect, credits],
  );

  const stop = () => controller.current?.abort();

  /**
   * The composer's generators: the prompt goes to the media studio's Pollinations endpoint
   * (POST /api/media/generate), and the result is recorded in the conversation.
   * @returns {Promise<'done' | 'aborted' | 'failed' | 'busy'>}
   */
  const generate = useCallback(
    async ({ kind, prompt }) => {
      if (!data || liveRef.current || mediaAbort.current) return 'busy';
      let conversationId = activeId;
      if (!conversationId) {
        const { conversation } = await request('/chat/conversations', { method: 'POST', body: {} });
        conversationId = conversation.id;
        setList((current) => ({ ...current, items: [conversation, ...current.items] }));
        const fresh = { id: conversationId, status: 'ready', messages: [], memory: conversation.memory, error: null };
        threadRef.current = fresh;
        setThread(fresh);
        setActiveId(conversationId);
        onSelect(conversationId);
      }
      const here = (change) => setThread((current) => (current.id === conversationId ? { ...current, messages: change(current.messages) } : current));
      const localId = `local-${Date.now()}`;
      here((messages) => [...messages, { id: localId, role: 'user', content: prompt, tool: kind, createdAt: new Date().toISOString() }]);
      const abort = new AbortController();
      mediaAbort.current = abort;
      setMediaLive({ conversationId, kind, prompt, started: Date.now() });
      try {
        const { media, credits: balance } = await request('/media/generate', { method: 'POST', body: { kind, prompt }, signal: abort.signal });
        credits.update(balance);
        const saved = await request(`/chat/conversations/${conversationId}/media`, { method: 'POST', body: { kind, mediaId: media.id } });
        here((messages) => [...messages.filter((message) => message.id !== localId), saved.userMessage, saved.message]);
        setList((current) => ({ ...current, items: [saved.conversation, ...current.items.filter((item) => item.id !== conversationId)] }));
        return 'done';
      } catch (error) {
        if (error.name === 'AbortError') {
          here((messages) => messages.filter((message) => message.id !== localId));
          return 'aborted';
        }
        credits.handleError(error);
        here((messages) => [
          ...messages,
          { id: `${localId}-error`, role: 'assistant', content: '', label: 'Pollinations', error: { message: error.message, detail: error.detail ?? null }, mediaError: { kind, prompt, localId } },
        ]);
        return 'failed';
      } finally {
        mediaAbort.current = null;
        setMediaLive(null);
      }
    },
    [data, activeId, onSelect, credits],
  );
  const stopMedia = () => mediaAbort.current?.abort();
  const retryMedia = (message) => {
    const { kind, prompt, localId } = message.mediaError;
    setThread((current) => ({ ...current, messages: current.messages.filter((item) => item.id !== localId && item.id !== message.id) }));
    return generate({ kind, prompt });
  };

  const compactNow = async () => {
    if (!activeId) return;
    setMemoryStatus({ state: 'updating', message: null });
    try {
      const { memory } = await request(`/chat/conversations/${activeId}/memory/compact`, { method: 'POST' });
      setThread((current) => ({ ...current, memory }));
      setMemoryStatus({ state: 'updated', message: null });
    } catch (error) {
      credits.handleError(error);
      setMemoryStatus({ state: 'failed', message: error.message });
      throw error;
    }
  };

  const remove = async (id) => {
    await request(`/chat/conversations/${id}`, { method: 'DELETE' });
    setList((current) => ({ ...current, items: current.items.filter((item) => item.id !== id) }));
    if (id === activeId) {
      setActiveId(null);
      onSelect(null);
    }
  };

  /** Renames a conversation (the server keeps its date, so it stays where it is in the history). */
  const rename = async (id, title) => {
    const { conversation } = await request(`/chat/conversations/${id}`, { method: 'PATCH', body: { title } });
    setList((current) => ({ ...current, items: current.items.map((item) => (item.id === id ? { ...item, ...conversation } : item)) }));
    return conversation;
  };

  const select = (id) => {
    setActiveId(id);
    onSelect(id);
  };

  const startNew = () => {
    if (liveRef.current) return;
    setActiveId(null);
    onSelect(null);
  };

  return {
    catalog,
    list,
    thread,
    live,
    memoryStatus,
    activeId,
    setActiveId,
    select,
    settings,
    workspace,
    freeProvider,
    freeModel,
    handoff,
    pipeline,
    research,
    memory,
    attachments,
    addFiles,
    removeAttachment,
    tool,
    setTool,
    generate,
    mediaLive,
    stopMedia,
    retryMedia,
    update,
    send,
    stop,
    compactNow,
    remove,
    rename,
    startNew,
    reload: () => {
      loadCatalog();
      loadList();
    },
  };
}
