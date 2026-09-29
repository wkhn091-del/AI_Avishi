import { motion } from 'framer-motion';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Settings } from 'lucide-react';
import { UserMenu } from '../../features/auth/UserMenu.jsx';
import { CreditsBadge } from '../../features/credits/CreditsBadge.jsx';
import { cx } from '../../lib/cx.js';
import { isolate } from '../../lib/format.js';
import { IconButton } from '../ui/Button.jsx';

export const SECTIONS = [
  { id: 'projects', label: 'פרויקטים' },
  { id: 'github', label: 'גיטהאב' },
  { id: 'chat', label: "צ'אט AI" },
  { id: 'media', label: 'סטודיו מדיה' },
  { id: 'links', label: 'קישורים' },
  { id: 'files', label: 'קבצים' },
];

/** Sticky bar: wordmark, section tabs (with counts) and server/AI status. */
export function TopBar({ tab, onTabChange, counts, health, onOpenSettings, sections = SECTIONS }) {
  const tabs = useRef({});

  // Arrow keys move between tabs, as expected for role="tablist". On a right-to-left
  // page the next tab is on the left, so the arrows follow what the user sees.
  const onKeyDown = (event) => {
    const rtl = document.documentElement.dir === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = sections.findIndex((section) => section.id === tab);
    const next = sections[(index + step + sections.length) % sections.length].id;
    onTabChange(next);
    tabs.current[next]?.focus();
  };

  // Six tabs don't fit a phone: the list scrolls, so keep the selected tab in view.
  useEffect(() => {
    tabs.current[tab]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab]);

  // The chat fills the window below this bar, so the bar's height (it wraps on phones) is published as --topbar-h.
  const bar = useRef(null);
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return undefined;
    const publish = () => document.documentElement.style.setProperty('--topbar-h', `${element.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <header ref={bar} className="sticky top-0 z-30 border-b border-line bg-paper/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3 sm:px-8">
        <Wordmark />
        <div
          role="tablist"
          aria-label="אזורים"
          onKeyDown={onKeyDown}
          className="order-last flex w-full overflow-x-auto rounded-full bg-sunken p-1 [scrollbar-width:none] sm:order-none sm:w-auto"
        >
          {sections.map((section) => {
            const selected = section.id === tab;
            return (
              <button
                key={section.id}
                ref={(element) => {
                  tabs.current[section.id] = element;
                }}
                id={`tab-${section.id}`}
                role="tab"
                aria-selected={selected}
                aria-controls={`panel-${section.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => onTabChange(section.id)}
                className={cx(
                  'relative shrink-0 rounded-full px-3 py-1.5 text-[14.5px] font-medium whitespace-nowrap transition-colors lg:px-4',
                  selected ? 'text-ink' : 'text-graphite hover:text-ink',
                )}
              >
                {selected && (
                  <motion.span
                    layoutId="tab-highlight"
                    className="absolute inset-0 rounded-full bg-surface shadow-[0_1px_2px_rgb(13_16_22/0.14)]"
                    transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                  />
                )}
                <span className="relative inline-flex items-baseline gap-2">
                  {section.label}
                  {counts[section.id] != null && (
                    <span className="font-narrow text-[13px] text-graphite">{counts[section.id]}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        <div className="ms-auto flex items-center gap-1.5">
          <ServerStatus health={health} />
          {onOpenSettings && (
          <IconButton label="הגדרות" onClick={onOpenSettings}>
            <Settings size={18} aria-hidden="true" />
          </IconButton>
          )}
          <CreditsBadge />
          <UserMenu compact />
        </div>
      </div>
    </header>
  );
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <rect x="1" y="8" width="4" height="11" rx="1.5" fill="currentColor" />
        <rect x="8" y="2" width="4" height="17" rx="1.5" fill="currentColor" />
        <rect x="15" y="11" width="4" height="8" rx="1.5" fill="currentColor" />
      </svg>
      <span className="font-wide text-[19px] font-bold tracking-[-0.01em]">Stash</span>
    </div>
  );
}

function ServerStatus({ health }) {
  if (health.status === 'loading') return null;
  if (health.status === 'error') {
    return <StatusChip tone="bg-danger" label="השרת לא זמין" hint={health.error} />;
  }
  const { ai } = health;
  if (ai.enabled && ai.ensemble?.length > 1) {
    const names = (ids) => ids.map((id) => ai.providers.find((provider) => provider.id === id)?.name ?? id).join(', ');
    return (
      <StatusChip
        tone="bg-ok"
        label={`אנסמבל של ${ai.ensemble.length} מודלים`}
        hint={`פרויקטים חדשים מסוכמים במקביל על ידי ${names(ai.ensemble)}, והתשובות מאוחדות על ידי ${names([ai.synthesizer])}.`}
      />
    );
  }
  if (ai.enabled) {
    return <StatusChip tone="bg-ok" label={`סיכומים באמצעות ${ai.providerName}`} hint={`פרויקטים חדשים מסוכמים על ידי ${isolate(ai.model)}.`} />;
  }
  if (ai.missingKey) {
    return (
      <StatusChip
        tone="bg-danger"
        label="חסר מפתח AI"
        hint="לספק שנבחר ב-AI_PROVIDER אין מפתח API בקובץ server/.env, ולכן נעשה שימוש בסיכומים המובנים."
      />
    );
  }
  return (
    <StatusChip
      tone="bg-mist"
      label="סיכומים מובנים"
      hint="הכותרות והתיאורים נלקחים מקובץ ה-README ומקובצי התצורה של כל פרויקט. כדי להשתמש במודל AI, הוסיפו מפתח API (למשל GEMINI_API_KEY) בקובץ server/.env."
    />
  );
}

function StatusChip({ tone, label, hint }) {
  return (
    <span title={hint} className="inline-flex items-center gap-2 text-[13.5px] text-graphite">
      <span className={cx('size-2 rounded-full', tone)} aria-hidden="true" />
      {label}
    </span>
  );
}
