import { Crown, Gift, LoaderCircle, SquarePen } from 'lucide-react';
import { UserMenu } from '../auth/UserMenu.jsx';
import { useMemo } from 'react';
import { IconButton } from '../../components/ui/Button.jsx';
import { cx } from '../../lib/cx.js';
import { formatUsd } from '../../lib/format.js';
import { ConversationMenu } from './ConversationMenu.jsx';

const DAY = 86_400_000;
const monthOf = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric' });

/** Conversations, newest first, under Today, Yesterday, the last 7 and 30 days, then month by month. */
export function groupByDate(items, now = new Date()) {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const groups = [];
  for (const item of [...items].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))) {
    const at = new Date(item.updatedAt).getTime();
    let label;
    if (at >= midnight) label = 'היום';
    else if (at >= midnight - DAY) label = 'אתמול';
    else if (at >= midnight - 7 * DAY) label = '7 הימים האחרונים';
    else if (at >= midnight - 30 * DAY) label = '30 הימים האחרונים';
    else label = monthOf.format(at);
    if (groups.at(-1)?.label === label) groups.at(-1).items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

function HistoryItem({ item, active, answering, onPick, onAction }) {
  const title = item.title || 'שיחה חדשה';
  const Mark = item.workspace === 'premium' ? Crown : item.workspace === 'free' ? Gift : null;
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => onPick(item.id)}
        aria-current={active ? 'page' : undefined}
        className={cx(
          'flex h-10 w-full items-center gap-2.5 rounded-xl ps-3 pe-10 text-start transition-colors',
          active ? 'bg-sunken text-ink' : 'text-graphite hover:bg-sunken/70 hover:text-ink',
        )}
      >
        {answering ? (
          <LoaderCircle size={13} className="shrink-0 animate-spin text-ink" role="img" aria-label="עונה עכשיו" />
        ) : Mark ? (
          <Mark size={13} className="shrink-0 opacity-55" aria-hidden="true" />
        ) : (
          <span className="w-[13px] shrink-0" aria-hidden="true" />
        )}
        {/* An English title keeps its own direction but lines up with the Hebrew ones (Chrome has no text-align: match-parent). */}
        <span className={cx('min-w-0 flex-1 truncate text-[14px] rtl:text-right', active && 'font-medium')} dir="auto">
          {title}
        </span>
        {item.cost > 0 && (
          <bdi dir="ltr" className="shrink-0 font-narrow text-[12px] text-mist">
            {formatUsd(item.cost)}
          </bdi>
        )}
      </button>
      <div className="absolute inset-y-0 end-1 flex items-center">
        <ConversationMenu
          title={title}
          busy={answering}
          onAction={(action) => onAction(action, item)}
          className={cx(
            'transition-opacity',
            active ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 data-open:opacity-100 pointer-coarse:opacity-100',
          )}
        />
      </div>
    </li>
  );
}

/**
 * Conversation history, for the desktop sidebar and the phone drawer: "New
 * chat", then the conversations grouped by date. Each has a three-dot menu
 * (Share, Rename, Delete). `onHide` collapses the sidebar or closes the drawer.
 */
export function HistoryPanel({ chat, headingId, onNewChat, onPick, onAction, onHide, hideLabel, hideIcon: HideIcon }) {
  const { list, activeId, live } = chat;
  const groups = useMemo(() => groupByDate(list.items), [list.items]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <h3 id={headingId} className="sr-only">
        היסטוריית שיחות
      </h3>
      <div className="flex items-center gap-1 px-2.5 pt-2.5 pb-2">
        <button
          type="button"
          onClick={onNewChat}
          disabled={Boolean(live)}
          data-autofocus
          className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 text-[14.5px] font-semibold text-ink transition-colors hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-50"
        >
          <SquarePen size={17} className="shrink-0" aria-hidden="true" />
          שיחה חדשה
        </button>
        <IconButton label={hideLabel} onClick={onHide}>
          <HideIcon size={18} aria-hidden="true" />
        </IconButton>
      </div>
      <nav aria-labelledby={headingId} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-6">
        {list.status === 'loading' && (
          <div className="space-y-2 px-3 pt-3" role="status" aria-label="טוען את השיחות">
            {[72, 88, 60, 80].map((width) => (
              <span key={width} className="block h-3.5 animate-pulse rounded-full bg-sunken motion-reduce:animate-none" style={{ width: `${width}%` }} />
            ))}
          </div>
        )}
        {list.status === 'error' && (
          <div className="px-3 pt-2 text-[13.5px] leading-relaxed text-graphite">
            <p>השיחות לא נטענו: {list.error}</p>
            <button type="button" onClick={chat.reload} className="mt-1 font-semibold text-ink underline underline-offset-2">
              טעינה מחדש
            </button>
          </div>
        )}
        {list.status === 'ready' && list.items.length === 0 && (
          <p className="px-3 pt-2 text-[13.5px] leading-relaxed text-mist">עדיין אין שיחות. ההודעה הראשונה פותחת שיחה חדשה.</p>
        )}
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label} className="mt-4 first:mt-1">
            <h4 className="px-3 pb-1 text-[12px] font-medium text-mist">{group.label}</h4>
            <ul className="space-y-px">
              {group.items.map((item) => (
                <HistoryItem
                  key={item.id}
                  item={item}
                  active={item.id === activeId}
                  answering={live?.conversationId === item.id}
                  onPick={onPick}
                  onAction={onAction}
                />
              ))}
            </ul>
          </section>
        ))}
      </nav>
      <div className="border-t border-line p-2">
        <UserMenu />
      </div>
    </div>
  );
}
