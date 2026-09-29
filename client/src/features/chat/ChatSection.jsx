import { BrainCircuit, Coins, Crown, Gift, LoaderCircle, MessagesSquare, PanelRight, PanelRightClose, PanelRightOpen, Settings, Siren, SquarePen, X } from 'lucide-react';
import { useMemo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, IconButton } from '../../components/ui/Button.jsx';
import { Drawer } from '../../components/ui/Drawer.jsx';
import { EmptyState, ErrorState } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toaster.jsx';
import { cx } from '../../lib/cx.js';
import { formatUsd } from '../../lib/format.js';
import { Loading, Notice } from '../projects/details/parts.jsx';
import { AssistantMessage, MediaPending, UserMessage } from './ChatMessage.jsx';
import { Composer } from './Composer.jsx';
import { DeleteDialog, RenameDialog } from './ConversationDialogs.jsx';
import { ConversationMenu } from './ConversationMenu.jsx';
import { HistoryPanel } from './HistoryPanel.jsx';
import { MemorySheet, ShareSheet, UsageSheet } from './sheets.jsx';
import { ArtifactContext } from './swarm/artifactContext.js';

const SUGGESTIONS = [
  'הסבר את ההבדל בין REST ל-GraphQL, עם דוגמה קצרה',
  'כתוב פונקציית debounce ב-JavaScript והסבר איך היא עובדת',
  'תן לי חמישה רעיונות לשם לאפליקציית משימות',
  'בנה אפליקציית React קטנה לרשימת משימות, עם קובצי JSX ו-CSS נפרדים',
];
const WORKSPACE_NAMES = { free: 'החינמית', premium: 'הפרימיום' };

/** A yes/no choice kept in localStorage (whether the desktop history sidebar is open). */
function useStoredFlag(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : stored === 'true';
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // storage may be unavailable; the choice still holds until the page reloads
    }
  }, [key, value]);
  return [value, setValue];
}

/** The switch between the two workspaces, in the chat header. */
function WorkspaceToggle({ chat }) {
  const { workspace, catalog } = chat;
  const option = (id, label, Icon) => (
    <button
      type="button"
      role="radio"
      aria-checked={workspace === id}
      onClick={() => chat.update({ workspace: id })}
      disabled={Boolean(chat.live)}
      className={cx(
        'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13.5px] font-semibold transition-colors disabled:cursor-not-allowed',
        workspace === id ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(13_16_22/0.14)]' : 'text-graphite hover:text-ink',
        !catalog.data[id].available && workspace !== id && 'opacity-60',
      )}
    >
      <Icon size={14} className="hidden sm:block" aria-hidden="true" />
      {label}
    </button>
  );
  return (
    <div role="radiogroup" aria-label="סביבת עבודה" className="flex shrink-0 rounded-full bg-sunken p-0.5">
      {option('free', 'חינמי', Gift)}
      {option('premium', 'פרימיום', Crown)}
    </div>
  );
}

function Welcome({ chat }) {
  const { workspace, settings, catalog } = chat;
  const premium = catalog.data.premium;
  const chosen = premium.models.find((model) => model.id === settings.premiumModel);
  let who;
  if (workspace === 'premium') {
    if (settings.emergency) who = <>מצב חירום: <bdi dir="ltr">Fable 5.1</bdi> עונה על כל ההודעות.</>;
    else if (chosen) who = <>עונה <bdi dir="ltr" className="font-medium text-ink">{chosen.label}</bdi>. את המודל והמאמץ מחליפים בכפתור שבתיבת ההודעה.</>;
    else who = <>הנתב האוטומטי מדרג כל בקשה ובוחר את המודל המתאים לה.</>;
  } else if (settings.freeMode === 'brainstorm') {
    who = <>סיעור מוחות: כל {catalog.data.free.providers.length} המודלים החינמיים עונים, והתשובות מאוחדות לאחת.</>;
  } else if (settings.freeMode === 'manual') {
    who = <>עונה <bdi className="font-medium text-ink">{chat.freeProvider?.name}</bdi> עם <bdi dir="ltr">{chat.freeModel}</bdi>.</>;
  } else {
    who = <>המודל החינמי המתאים נבחר לכל בקשה.</>;
  }
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center py-10 text-center">
      <span className={cx('grid size-12 place-items-center rounded-2xl', settings.emergency && workspace === 'premium' ? 'bg-danger text-paper' : 'bg-sunken text-ink')}>
        {workspace === 'premium' ? <Crown size={22} aria-hidden="true" /> : <Gift size={22} aria-hidden="true" />}
      </span>
      <h3 className="mt-4 font-wide text-[22px] font-bold">במה אפשר לעזור?</h3>
      <p className="mt-1.5 text-[14.5px] text-graphite">{who}</p>
      <ul className="mt-6 flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((text) => (
          <li key={text}>
            <button
              type="button"
              onClick={() => chat.send({ content: text })}
              className="rounded-full border border-line px-3.5 py-1.5 text-[13.5px] text-graphite transition-colors hover:border-line-strong hover:text-ink"
              dir="auto"
            >
              {text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MemoryDivider({ onOpen }) {
  return (
    <li className="flex items-center gap-3 text-[12.5px] text-mist">
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
      <button type="button" onClick={onOpen} className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 hover:text-ink">
        <BrainCircuit size={13} aria-hidden="true" />
        ההודעות הקודמות סוכמו בזיכרון השיחה ואינן נשלחות עוד למודלים
      </button>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
    </li>
  );
}

function FragmentWithDivider({ divider, onOpenMemory, children }) {
  return (
    <>
      {divider && <MemoryDivider onOpen={onOpenMemory} />}
      {children}
    </>
  );
}

function MessageList({ chat, onOpenMemory }) {
  const { thread, live, memoryStatus } = chat;
  // Generated projects: each one's latest version gets the live panel, and its "what would you like to change?"
  // sends a follow-up that edits that project.
  const busy = Boolean(live || chat.mediaLive);
  const heads = useMemo(() => {
    const map = new Map();
    for (const message of thread.messages) if (message.artifact?.id) map.set(message.artifact.id, Math.max(map.get(message.artifact.id) ?? 0, message.artifact.version ?? 1));
    return map;
  }, [thread.messages]);
  const { send } = chat;
  const artifacts = useMemo(
    () => ({ conversationId: thread.id, heads, busy, canEdit: chat.workspace === 'premium', edit: (id, content) => send({ content, artifact: id }) }),
    [thread.id, heads, busy, chat.workspace, send],
  );
  const scroller = useRef(null);
  const list = useRef(null);
  const atBottom = useRef(true);
  const liveHere = live && live.conversationId === thread.id;
  const messages = thread.messages;
  const windowStart = thread.memory?.windowStart ?? 0;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages.length, live?.text, live?.reasoning, live?.retry, live?.stage, live?.experts?.length, live?.team, live?.research, memoryStatus.state, thread.id]);
  // Content that grows by itself (the development team's live dashboard, a panel opening) keeps a reader
  // who's at the bottom there too.
  useEffect(() => {
    const element = scroller.current;
    if (!element || !list.current || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(list.current);
    return () => observer.disconnect();
  }, [thread.id]);

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-6 sm:px-6"
    >
      {thread.status === 'loading' && <Loading label="טוען את השיחה…" />}
      {thread.status === 'error' && (
        <Notice tone="error" title="טעינת השיחה נכשלה">
          {thread.error}
        </Notice>
      )}
      {thread.status !== 'loading' && thread.status !== 'error' && messages.length === 0 && !liveHere && <Welcome chat={chat} />}
      <ArtifactContext.Provider value={artifacts}>
      <ol ref={list} className="mx-auto max-w-3xl space-y-7 pb-6">
        {messages.map((message, index) => (
          <FragmentWithDivider key={message.id} divider={index === windowStart && windowStart > 0} onOpenMemory={onOpenMemory}>
            {message.role === 'user' ? (
              <UserMessage message={message} />
            ) : (
              <AssistantMessage
                message={message}
                isLast={index === messages.length - 1 && !liveHere}
                onRegenerate={message.mediaError ? () => chat.retryMedia(message) : live || chat.mediaLive ? undefined : () => chat.send({ regenerate: true })}
              />
            )}
          </FragmentWithDivider>
        ))}
        {liveHere && (
          <AssistantMessage
            message={{
              content: live.text,
              reasoning: live.reasoning,
              route: live.route,
              experts: live.experts,
              team: live.team,
              pipeline: live.pipeline,
              research: live.research,
              recalled: live.recalled,
              label: live.route?.label,
              effort: live.effort,
            }}
            streaming
            stage={live.stage}
            retry={live.retry}
          />
        )}
        {chat.mediaLive?.conversationId === thread.id && <MediaPending live={chat.mediaLive} />}
        {memoryStatus.state === 'updating' && (
          <li className="flex items-center justify-center gap-2 text-[13px] text-graphite" role="status">
            <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
            מעדכן את זיכרון השיחה (<bdi dir="ltr">project_state.md</bdi>)…
          </li>
        )}
      </ol>
      </ArtifactContext.Provider>
    </div>
  );
}

function EmptyWorkspace({ chat, onOpenSettings }) {
  const { workspace, catalog } = chat;
  const other = workspace === 'free' ? 'premium' : 'free';
  const keys = catalog.data[workspace].keys;
  return (
    <div className="grid flex-1 place-items-center px-6 py-10 text-center">
      <div className="max-w-md">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-sunken text-graphite">
          {workspace === 'premium' ? <Crown size={22} aria-hidden="true" /> : <Gift size={22} aria-hidden="true" />}
        </span>
        <h3 className="mt-4 text-[18px] font-semibold">בסביבה {WORKSPACE_NAMES[workspace]} אין עדיין ספק מוגדר</h3>
        <p className="mt-2 text-[14px] leading-relaxed text-graphite">הוסיפו לפחות אחד מהמפתחות האלה בקובץ server/.env והפעילו מחדש את השרת:</p>
        <ul dir="ltr" className="mt-3 flex flex-wrap justify-center gap-1.5 font-mono text-[12.5px]">
          {keys.map((key) => (
            <li key={key} className="rounded-md bg-sunken px-2 py-0.5">
              {key}
            </li>
          ))}
        </ul>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button variant="primary" icon={Settings} onClick={onOpenSettings}>
            מצב הספקים בהגדרות
          </Button>
          {catalog.data[other].available && <Button onClick={() => chat.update({ workspace: other })}>מעבר לסביבה {WORKSPACE_NAMES[other]}</Button>}
        </div>
      </div>
    </div>
  );
}

/**
 * The chat pane's header: history (the drawer on narrow screens, the sidebar
 * when it's hidden on wide ones), the conversation's title, the workspace
 * switch, cost and memory, a new chat, and the conversation's menu.
 */
function ChatHeader({ chat, historyShown, onShowHistory, onOpenDrawer, onNewChat, onAction, onOpenUsage, onOpenMemory }) {
  const { activeId, list, thread, memoryStatus, live } = chat;
  const active = list.items.find((item) => item.id === activeId);
  const usage = thread.id === activeId ? thread.usage : null;
  const memory = thread.id === activeId ? thread.memory : null;
  const title = active?.title || 'שיחה חדשה';
  return (
    <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-2 sm:gap-1.5 sm:px-3">
      <span className="lg:hidden">
        <IconButton label="היסטוריית שיחות" aria-haspopup="dialog" onClick={onOpenDrawer}>
          <PanelRight size={18} aria-hidden="true" />
        </IconButton>
      </span>
      {!historyShown && (
        <span className="hidden lg:block">
          <IconButton label="הצגת היסטוריית השיחות" onClick={onShowHistory}>
            <PanelRightOpen size={18} aria-hidden="true" />
          </IconButton>
        </span>
      )}
      <h3
        className={cx('hidden min-w-0 flex-1 truncate px-1.5 text-[15px] font-semibold rtl:text-right sm:block', !active && 'text-mist')}
        dir="auto"
        title={active ? title : undefined}
      >
        {title}
      </h3>
      <span className="flex-1 sm:hidden" />
      <WorkspaceToggle chat={chat} />
      {usage && (
        <span className="hidden sm:block">
          <Button variant="ghost" size="sm" icon={Coins} onClick={onOpenUsage} aria-haspopup="dialog" title="עלות משוערת של השיחה">
            <bdi dir="ltr">
              {usage.estimated ? '~' : ''}
              {formatUsd(usage.cost)}
            </bdi>
          </Button>
        </span>
      )}
      {activeId && (
        <Button variant="ghost" size="sm" icon={memoryStatus.state === 'updating' ? LoaderCircle : BrainCircuit} onClick={onOpenMemory} aria-haspopup="dialog" aria-label="זיכרון השיחה">
          <span className="hidden sm:inline">זיכרון</span>
          {memory && (
            <span className="hidden text-[12px] font-normal text-mist sm:inline">
              {memory.turnsSince}/{memory.compactEvery}
            </span>
          )}
        </Button>
      )}
      <span className={cx(historyShown && 'lg:hidden')}>
        <IconButton label="שיחה חדשה" onClick={onNewChat} disabled={Boolean(live)}>
          <SquarePen size={17} aria-hidden="true" />
        </IconButton>
      </span>
      {active && <ConversationMenu title={title} busy={live?.conversationId === active.id} onAction={(action) => onAction(action, active)} />}
    </div>
  );
}

/**
 * The AI workspace, laid out like a chat app: conversation history on the start
 * side (a sidebar that can be hidden on wide screens, a drawer on narrow ones),
 * and the conversation with its floating message box. Every conversation has a
 * menu to share it (as Markdown), rename it or delete it.
 */
export function ChatSection({ chat, github, onOpenSettings }) {
  const toast = useToast();
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historyShown, setHistoryShown] = useStoredFlag('stash.chat.history', true);
  // Share, rename or delete, and its conversation (kept while the sheet or dialog animates closed).
  const [dialog, setDialog] = useState({ kind: null, item: null });
  const { catalog, activeId, thread, memoryStatus, workspace, settings } = chat;
  const data = catalog.data;
  const nothing = catalog.status === 'ready' && !data.free.available && !data.premium.available;
  const emergency = workspace === 'premium' && settings.emergency;
  const memory = thread.id === activeId ? thread.memory : null;

  useEffect(() => {
    if (memoryStatus.state === 'updated') toast.success('זיכרון השיחה עודכן (project_state.md)');
    if (memoryStatus.state === 'failed' && memoryStatus.message) toast.error(`עדכון הזיכרון נכשל: ${memoryStatus.message}`);
  }, [memoryStatus, toast]);

  // The drawer is for narrow screens: widening the window past it closes it.
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 1024px)');
    const onChange = () => wide.matches && setDrawerOpen(false);
    wide.addEventListener('change', onChange);
    return () => wide.removeEventListener('change', onChange);
  }, []);

  const pick = (id) => {
    chat.select(id);
    setDrawerOpen(false);
  };
  const startNew = () => {
    chat.startNew();
    setDrawerOpen(false);
  };
  const act = (kind, item) => {
    setDrawerOpen(false);
    setDialog({ kind, item });
  };
  const closeDialog = () => setDialog((current) => ({ ...current, kind: null }));
  const rename = async (id, title) => {
    await chat.rename(id, title);
    toast.success('השם נשמר');
  };
  const remove = async (id) => {
    await chat.remove(id);
    toast.success('השיחה נמחקה');
  };
  const compactNow = async () => {
    setCompacting(true);
    try {
      await chat.compactNow();
    } catch {
      // the hook reports the failure
    } finally {
      setCompacting(false);
    }
  };

  const history = (props) => <HistoryPanel chat={chat} onNewChat={startNew} onPick={pick} onAction={act} {...props} />;

  return (
    <div className="sm:pt-6">
      <h2 id="chat-title" className="sr-only">
        סביבת העבודה של ה-AI
      </h2>
      {catalog.status === 'error' && (
        <div className="pt-6 sm:pt-0">
          <ErrorState message={catalog.error} onRetry={chat.reload} />
        </div>
      )}
      {nothing && (
        <div className="pt-6 sm:pt-0">
          <EmptyState
            art={<MessagesSquare size={30} strokeWidth={1.6} className="text-graphite" aria-hidden="true" />}
            title="חברו מודל AI"
            action={
              <Button variant="primary" icon={Settings} onClick={onOpenSettings}>
                מצב הספקים בהגדרות
              </Button>
            }
            footnote="למשל GROQ_API_KEY או ANTHROPIC_API_KEY בקובץ server/.env"
          >
            כדי לשוחח צריך מפתח API של ספק אחד לפחות. בסביבה החינמית: Groq, OpenRouter, Cohere ו-Hugging Face. בסביבת הפרימיום: Anthropic, OpenAI, Gemini, DeepSeek ו-Kimi.
          </EmptyState>
        </div>
      )}
      {catalog.status === 'loading' && (
        <div className="pt-6 sm:pt-0">
          <Loading label="טוען את סביבות העבודה…" />
        </div>
      )}

      {catalog.status === 'ready' && !nothing && (
        <div
          className={cx(
            '-mx-4 flex overflow-hidden bg-surface sm:mx-0 sm:rounded-[22px] sm:border',
            'h-[calc(100dvh-var(--topbar-h,64px))] min-h-[420px] sm:h-[calc(100dvh-var(--topbar-h,64px)-3rem)]',
            emergency ? 'sm:border-danger/60 sm:ring-2 sm:ring-danger/15' : 'sm:border-line',
          )}
        >
          <aside
            aria-label="היסטוריית שיחות"
            inert={!historyShown}
            className={cx(
              'hidden shrink-0 overflow-hidden bg-paper transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none lg:block',
              historyShown ? 'w-[272px] border-e border-line' : 'w-0',
            )}
          >
            <div className="h-full w-[272px]">
              {history({ headingId: 'history-sidebar-title', onHide: () => setHistoryShown(false), hideLabel: 'הסתרת היסטוריית השיחות', hideIcon: PanelRightClose })}
            </div>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <ChatHeader
              chat={chat}
              historyShown={historyShown}
              onShowHistory={() => setHistoryShown(true)}
              onOpenDrawer={() => setDrawerOpen(true)}
              onNewChat={startNew}
              onAction={act}
              onOpenUsage={() => setUsageOpen(true)}
              onOpenMemory={() => setMemoryOpen(true)}
            />
            {emergency && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-danger px-4 py-2 text-[13.5px] text-paper" role="status">
                <Siren size={15} aria-hidden="true" />
                <span className="min-w-0 flex-1 font-medium">
                  מצב חירום פעיל: כל ההודעות נשלחות ל-<bdi dir="ltr">Fable 5.1</bdi> בלי ניתוב. המודל דורש קרדיטי שימוש.
                </span>
                <button type="button" onClick={() => chat.update({ emergency: false })} className="rounded-full bg-paper/20 px-3 py-0.5 text-[13px] font-semibold hover:bg-paper/30">
                  כיבוי
                </button>
              </div>
            )}
            {data[workspace].available ? (
              <>
                <MessageList chat={chat} onOpenMemory={() => setMemoryOpen(true)} />
                <Composer chat={chat} github={github} onOpenSettings={onOpenSettings} />
              </>
            ) : (
              <EmptyWorkspace chat={chat} onOpenSettings={onOpenSettings} />
            )}
          </div>
        </div>
      )}

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} labelledBy="history-drawer-title">
        {history({ headingId: 'history-drawer-title', onHide: () => setDrawerOpen(false), hideLabel: 'סגירת היסטוריית השיחות', hideIcon: X })}
      </Drawer>
      <ShareSheet open={dialog.kind === 'share'} onClose={closeDialog} conversation={dialog.item} />
      <RenameDialog open={dialog.kind === 'rename'} conversation={dialog.item} onClose={closeDialog} onSave={rename} />
      <DeleteDialog open={dialog.kind === 'delete'} conversation={dialog.item} onClose={closeDialog} onConfirm={remove} />
      <UsageSheet open={usageOpen} onClose={() => setUsageOpen(false)} conversationId={activeId} />
      <MemorySheet open={memoryOpen} onClose={() => setMemoryOpen(false)} memory={memory} conversationId={activeId} onCompact={compactNow} busy={compacting || memoryStatus.state === 'updating'} />
    </div>
  );
}
