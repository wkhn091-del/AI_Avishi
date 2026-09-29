import {
  Check, ChevronLeft, ChevronRight, Clapperboard, Cloud, Coins, Copy, Download, FolderGit2, FolderOpen, Gauge, Images, Music, Palette, RefreshCw, Search, Settings, Share2, Shuffle,
  Brain, Globe, ListChecks, Siren, Sparkles, Users, Workflow,
} from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { BottomSheet } from '../../components/ui/BottomSheet.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { useToast } from '../../components/ui/Toaster.jsx';
import { copyText } from '../../lib/clipboard.js';
import { cx } from '../../lib/cx.js';
import { request, resourceUrl } from '../../lib/api.js';
import { formatRelative, formatTokens, formatUsd, pluralize } from '../../lib/format.js';
import { conversationMarkdown, downloadText, fileNameOf } from './shareConversation.js';

const ChatMarkdown = lazy(() => import('./ChatMarkdown.jsx'));

/** One choice in a sheet: title and subtitle on the start side, a tag and a check mark on the end side. */
function Row({ title, subtitle, tag, tagTone = 'neutral', tags = [], selected, disabled, onClick, icon: Icon, iconTone, trailing, autoFocus, role, checked }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={role ? undefined : selected}
      role={role}
      aria-checked={role ? checked : undefined}
      data-autofocus={autoFocus || undefined}
      className={cx(
        'flex w-full items-center gap-3 px-6 py-3 text-start transition-colors',
        disabled ? 'cursor-not-allowed opacity-45' : 'hover:bg-sunken/70 focus-visible:bg-sunken/70',
      )}
    >
      {Icon && (
        <span className={cx('grid size-9 shrink-0 place-items-center rounded-xl', iconTone === 'danger' ? 'bg-danger/10 text-danger' : 'bg-sunken text-graphite')}>
          <Icon size={17} aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[15.5px] font-semibold">{title}</span>
          {tag && (
            <span className={cx('rounded-full px-2 py-0.5 text-[11.5px] font-medium', tagTone === 'warn' ? 'bg-[#fdecc8] text-[#8a5a00]' : 'bg-sunken text-graphite')}>
              {tag}
            </span>
          )}
          {tags.filter(Boolean).map((text) => (
            <span key={text} className="rounded-full bg-sunken px-2 py-0.5 text-[11.5px] font-medium text-graphite">
              {text}
            </span>
          ))}
        </span>
        {subtitle && <span className="mt-0.5 block text-[13px] leading-snug text-graphite">{subtitle}</span>}
      </span>
      {trailing}
      {selected && <Check size={18} className="shrink-0 text-ink" aria-hidden="true" />}
    </button>
  );
}

function SectionLabel({ children }) {
  return <p className="px-6 pt-3 pb-1 text-[12px] font-semibold tracking-wide text-mist">{children}</p>;
}

/** A switch's track and knob, at the end of a Row with role="switch". */
function Switch({ on, tone }) {
  return (
    <span className={cx('relative h-5 w-9 shrink-0 rounded-full transition-colors', on ? (tone === 'danger' ? 'bg-danger' : 'bg-ink') : 'bg-line-strong')} aria-hidden="true">
      <span className={cx('absolute top-0.5 size-4 rounded-full bg-paper transition-all', on ? 'start-4.5' : 'start-0.5')} />
    </span>
  );
}

const Divider = () => <div className="mx-6 my-1 border-t border-line" />;

function BackButton({ onClick }) {
  return (
    <button type="button" onClick={onClick} className="mx-4 mb-1 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[13.5px] font-medium text-graphite hover:text-ink">
      <ChevronRight size={16} aria-hidden="true" />
      חזרה
    </button>
  );
}

/** Which page of a two-page sheet is showing; moving between pages puts focus on the new page. */
function useSheetView(open) {
  const [view, setView] = useState('main');
  const body = useRef(null);
  const moved = useRef(false);
  useEffect(() => {
    if (open) {
      setView('main');
      moved.current = false;
    }
  }, [open]);
  useEffect(() => {
    if (moved.current) (body.current?.querySelector('[data-autofocus]') ?? body.current?.querySelector('button:not(:disabled)'))?.focus();
  }, [view]);
  const go = (next) => {
    moved.current = true;
    setView(next);
  };
  return { view, go, body };
}

/** The effort row at the top of the model sheets: the current level, and the way into the list of levels. */
function EffortEntry({ efforts, selected, onOpen }) {
  const effort = efforts.find((item) => item.id === selected) ?? efforts.find((item) => item.default) ?? efforts[0];
  return (
    <Row
      icon={Gauge}
      title="מאמץ"
      subtitle={effort.description}
      onClick={onOpen}
      trailing={
        <span className="flex shrink-0 items-center gap-0.5 text-[13.5px] font-medium text-graphite">
          {effort.label}
          <ChevronLeft size={17} className="text-mist" aria-hidden="true" />
        </span>
      }
    />
  );
}

/** The effort levels, each with what it does. */
function EffortView({ efforts, selected, emergency, onPick, onBack }) {
  return (
    <>
      <BackButton onClick={onBack} />
      {efforts.map((effort) => (
        <Row
          key={effort.id}
          title={effort.label}
          subtitle={effort.id === 'max' && emergency ? 'במצב חירום רק Fable 5.1 עונה, ולכן זה רץ כביקורת עצמית' : effort.description}
          tag={effort.tag ?? (effort.default ? 'ברירת מחדל' : null)}
          tagTone={effort.tag ? 'warn' : 'neutral'}
          selected={selected === effort.id}
          autoFocus={selected === effort.id}
          onClick={() => onPick(effort.id)}
        />
      ))}
    </>
  );
}

/**
 * Premium model and effort, in one sheet: the effort level, the auto-router,
 * every model of every provider, grouped by provider (a provider without a key
 * shows its models disabled), then the cost-saving handoff and emergency mode.
 * Choosing a model or an effort closes the sheet; the switches don't.
 */
const TEAM_VERBS = Object.freeze({ architect: 'מתכנן', builder: 'כותבים את הקבצים במקביל', review: 'בודק ומחזיר לתיקון', frontend: 'בונה את הממשק', backend: 'כותב את השרת' });

/** Both workspaces: live web research and the long-term memory, and the way into what the memory holds. */
function ContextRows({ catalog, research, memory, onChange, onOpenMemory }) {
  const web = catalog.research;
  const remember = catalog.longTermMemory;
  return (
    <>
      {web?.enabled && (
        <Row
          icon={Globe}
          role="switch"
          checked={research}
          disabled={!web.available}
          title="חיפוש ברשת"
          subtitle={
            !web.available
              ? `דורש מפתח של ${web.provider} (${web.keyEnv})`
              : research
                ? `המנהל מחליט מתי צריך מידע עדכני, ו-${web.provider} מביא מקורות מהרשת`
                : 'כבוי: התשובות מבוססות רק על הידע של המודלים'
          }
          onClick={() => onChange({ research: !research })}
          trailing={<Switch on={research} />}
        />
      )}
      {remember?.available && (
        <>
          <Row
            icon={Brain}
            role="switch"
            checked={memory}
            title="זיכרון לטווח ארוך"
            subtitle={memory ? 'לומד את ההעדפות שלך ונותן אותן לכל מודל, בכל שיחה' : 'כבוי: שום דבר לא נלמד ולא נשלף'}
            onClick={() => onChange({ memory: !memory })}
            trailing={<Switch on={memory} />}
          />
          <Row icon={ListChecks} title="מה למדתי עליך" subtitle="לראות, להוסיף, לערוך ולמחוק זיכרונות" onClick={onOpenMemory} trailing={<ChevronLeft size={18} className="text-mist" aria-hidden="true" />} />
        </>
      )}
    </>
  );
}

export function PremiumModelSheet({ open, onClose, catalog, settings, handoff, pipeline, research, memory, onChange, onOpenMemory }) {
  const { view, go, body } = useSheetView(open);
  const premium = catalog.premium;
  const emergency = Boolean(settings.emergency);
  const choose = (changes) => {
    onChange(changes);
    onClose();
  };
  const isChosen = (id) => !emergency && settings.premiumModel === id;
  const providers = [...new Set(premium.models.map((model) => model.provider))];
  const row = (model) => (
    <Row
      key={model.id}
      title={
        <bdi dir="ltr" className="font-semi-wide">
          {model.label}
        </bdi>
      }
      subtitle={model.available ? model.subtitle : `${model.subtitle}. דורש ${model.keyEnv}.`}
      tag={model.tag}
      tagTone="warn"
      tags={model.tag ? [] : [model.costLabel, model.video ? 'וידאו' : null]}
      selected={isChosen(model.id)}
      autoFocus={isChosen(model.id)}
      disabled={!model.available}
      onClick={() => choose({ premiumModel: model.id, emergency: false })}
    />
  );
  return (
    <BottomSheet open={open} onClose={onClose} id="premium-models" title={view === 'effort' ? 'מאמץ' : 'מודל ומאמץ'}>
      <div ref={body}>
        {view === 'effort' ? (
          <EffortView efforts={catalog.efforts} selected={settings.effort} emergency={emergency} onPick={(effort) => choose({ effort })} onBack={() => go('main')} />
        ) : (
          <>
            <EffortEntry efforts={catalog.efforts} selected={settings.effort} onOpen={() => go('effort')} />
            <Divider />
            {emergency && (
              <p className="mx-6 my-2 rounded-xl bg-danger/10 px-3 py-2 text-[13px] leading-snug text-danger">
                מצב חירום פעיל, ולכן כל ההודעות נשלחות ל-<bdi dir="ltr">Fable 5.1</bdi>. בחירת מודל תכבה אותו.
              </p>
            )}
            <Row
              icon={Shuffle}
              title="אוטומטי"
              subtitle={
                premium.classifier === 'gemini'
                  ? 'Gemini Flash מדרג כל בקשה (1 עד 10) ובוחר את המודל המתאים'
                  : 'דירוג מובנה של כל בקשה (1 עד 10) בוחר את המודל המתאים'
              }
              selected={isChosen('auto')}
              autoFocus={isChosen('auto')}
              onClick={() => choose({ premiumModel: 'auto', emergency: false })}
            />
            {providers.map((provider) => {
              const models = premium.models.filter((model) => model.provider === provider);
              return (
                <div key={provider} role="group" aria-label={models[0].providerName}>
                  <SectionLabel>{models[0].providerName}</SectionLabel>
                  {models.map(row)}
                </div>
              );
            })}
            <Divider />
            <Row
              icon={Coins}
              role="switch"
              checked={handoff}
              title="העברה חסכונית"
              subtitle={
                handoff
                  ? `המודל שנבחר מתכנן ועונה בפעם הראשונה; בהמשך, תיקונים והשלמות עוברים ל-${premium.handoff.workhorse ?? 'מודל זול'}`
                  : 'כבויה: המודל שנבחר עונה על כל ההודעות'
              }
              onClick={() => onChange({ handoff: !handoff })}
              trailing={<Switch on={handoff} />}
            />
            {premium.pipeline?.available && (
              <Row
                icon={Workflow}
                role="switch"
                checked={pipeline}
                title="צוות פיתוח"
                subtitle={
                  pipeline
                    ? `בקשות קוד מורכבות (${premium.pipeline.minComplexity}/10 ומעלה) עוברות לצוות: ${premium.pipeline.team.map((member) => `${member.model} ${TEAM_VERBS[member.role]}`).join(', ')}`
                    : 'כבוי: כל בקשה נענית על ידי מודל אחד'
                }
                onClick={() => onChange({ pipeline: !pipeline })}
                trailing={<Switch on={pipeline} />}
              />
            )}
            <ContextRows catalog={catalog} research={research} memory={memory} onChange={onChange} onOpenMemory={onOpenMemory} />
            <Row
              icon={Siren}
              iconTone="danger"
              role="switch"
              checked={emergency}
              title="מצב חירום"
              subtitle={premium.emergency.available ? 'כל ההודעות נשלחות ל-Fable 5.1, בלי ניתוב. המודל דורש קרדיטי שימוש.' : 'דורש מפתח של Anthropic (ANTHROPIC_API_KEY)'}
              disabled={!premium.emergency.available}
              onClick={() => onChange({ emergency: !emergency })}
              trailing={<Switch on={emergency} tone="danger" />}
            />
          </>
        )}
      </div>
    </BottomSheet>
  );
}

/** A round upload button in the top row of the "+" menu (56px: easy to hit with a thumb). */
function CircleAction({ icon: Icon, label, note, disabled, soon, onClick, autoFocus }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-autofocus={autoFocus || undefined}
      className="group flex w-[4.75rem] flex-col items-center gap-1.5 rounded-2xl pt-1 pb-0.5 text-[13px] font-medium text-ink outline-none disabled:opacity-40"
    >
      <span
        className={cx(
          'grid size-14 place-items-center rounded-full border transition-[background-color,scale] duration-150 group-focus-visible:ring-2 group-focus-visible:ring-ink/30 group-active:scale-95',
          soon ? 'border-dashed border-line-strong text-mist' : 'border-line bg-sunken group-hover:bg-line/70',
        )}
      >
        <Icon size={22} aria-hidden="true" />
      </span>
      <span className={soon ? 'text-graphite' : undefined}>{label}</span>
      {note && <span className="-mt-0.5 rounded-full bg-sunken px-2 py-px text-[11px] font-normal text-graphite">{note}</span>}
    </button>
  );
}

const GENERATORS = [
  { kind: 'image', icon: Palette, title: 'יצירת תמונה', subtitle: 'חקירה ויזואלית: התיאור שלכם הופך לתמונה' },
  { kind: 'video', icon: Clapperboard, title: 'יצירת וידאו', subtitle: 'סרטון קצר מתוך תיאור', tag: 'דורש Pollen' },
  { kind: 'music', icon: Music, title: 'יצירת מוזיקה', subtitle: 'קטע מוזיקלי מתוך תיאור', tag: 'דורש Pollen' },
];

/**
 * "+": round upload buttons (files, gallery, and Drive, which isn't connected yet), the
 * media generators (the next prompt goes to Pollinations), and a GitHub repository.
 */
export function ComposerMenu({ open, onClose, catalog, workspace, tool, onPickFiles, onPickGallery, onGenerate, onPickRepo }) {
  const [driveNote, setDriveNote] = useState(false);
  useEffect(() => {
    if (open) setDriveNote(false);
  }, [open]);
  const premium = workspace === 'premium';
  const limits = catalog.attachments;
  const andClose = (action) => () => {
    onClose();
    action();
  };
  const note = driveNote
    ? 'החיבור ל-Google Drive עוד לא זמין. בינתיים אפשר לצרף מ"קבצים" או מ"גלריה".'
    : !premium
      ? 'העלאת קבצים זמינה בסביבת הפרימיום.'
      : `תמונות עד ${limits.imageMaxMb}MB, וידאו עד ${limits.videoMaxMb}MB.${limits.video ? '' : ' וידאו דורש GEMINI_API_KEY.'}`;
  return (
    <BottomSheet open={open} onClose={onClose} id="composer-menu" title="הוספה לשיחה">
      <div className="flex justify-center gap-4 px-6 pt-1" role="group" aria-label="העלאת קבצים">
        <CircleAction icon={FolderOpen} label="קבצים" disabled={!premium} autoFocus={premium} onClick={andClose(onPickFiles)} />
        <CircleAction icon={Images} label="גלריה" disabled={!premium} onClick={andClose(onPickGallery)} />
        <CircleAction icon={Cloud} label="Drive" note="בקרוב" soon onClick={() => setDriveNote(true)} />
      </div>
      <p className={cx('px-6 pt-2 pb-4 text-center text-[12.5px]', driveNote ? 'text-graphite' : 'text-mist')} role={driveNote ? 'status' : undefined}>
        {note}
      </p>
      <div className="mx-6 border-t border-line" />
      <SectionLabel>יצירה עם Pollinations</SectionLabel>
      {GENERATORS.map((item) => (
        <Row
          key={item.kind}
          icon={item.icon}
          title={item.title}
          subtitle={item.subtitle}
          tags={item.tag ? [item.tag] : []}
          selected={tool === item.kind}
          autoFocus={!premium && item.kind === 'image'}
          onClick={andClose(() => onGenerate(item.kind))}
        />
      ))}
      <div className="mx-6 border-t border-line" />
      <Row icon={FolderGit2} title="מאגר GitHub" subtitle="עץ הקבצים וה-README של המאגר נשלחים למודל" onClick={andClose(onPickRepo)} />
    </BottomSheet>
  );
}

/** Free model and effort, in one sheet: the effort level, Auto-Free, Brainstorm, or one model of your choice (searchable). */
export function FreeModelSheet({ open, onClose, catalog, settings, research, memory, onChange, onOpenMemory }) {
  const [query, setQuery] = useState('');
  const { view, go, body } = useSheetView(open);
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);
  const choose = (changes) => {
    onChange(changes);
    onClose();
  };
  const groups = useMemo(
    () =>
      catalog.free.providers.map((provider) => ({
        ...provider,
        models: provider.models.filter((model) => !query || model.id.toLowerCase().includes(query.toLowerCase())).slice(0, query ? 50 : 8),
      })),
    [catalog, query],
  );
  return (
    <BottomSheet open={open} onClose={onClose} id="free-models" title={view === 'effort' ? 'מאמץ' : 'מודל ומאמץ'}>
      <div ref={body}>
        {view === 'effort' ? (
          <EffortView efforts={catalog.efforts} selected={settings.effort} onPick={(effort) => choose({ effort })} onBack={() => go('main')} />
        ) : (
          <>
            <EffortEntry efforts={catalog.efforts} selected={settings.effort} onOpen={() => go('effort')} />
            <Divider />
            <Row
              icon={Sparkles}
              title="אוטומטי-חינמי"
              subtitle="בוחר את המודל החינמי המתאים לכל בקשה, ומדלג על ספקים שהגיעו למכסה"
              selected={settings.freeMode === 'auto'}
              onClick={() => choose({ freeMode: 'auto' })}
              autoFocus={settings.freeMode === 'auto'}
            />
            <Row
              icon={Users}
              title="סיעור מוחות (כולם)"
              subtitle={`כל ${catalog.free.providers.length} הספקים החינמיים עונים במקביל, והתשובות מאוחדות לתשובה אחת`}
              selected={settings.freeMode === 'brainstorm'}
              onClick={() => choose({ freeMode: 'brainstorm' })}
              autoFocus={settings.freeMode === 'brainstorm'}
            />
            <Divider />
            <ContextRows catalog={catalog} research={research} memory={memory} onChange={onChange} onOpenMemory={onOpenMemory} />
            <SectionLabel>בחירה ידנית</SectionLabel>
            <div className="px-6 pb-2">
              <label className="flex h-10 items-center gap-2 rounded-full border border-line-strong px-3 focus-within:border-graphite">
                <Search size={15} className="text-mist" aria-hidden="true" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="חיפוש מודל"
                  aria-label="חיפוש מודל"
                  className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-mist"
                />
              </label>
            </div>
            {groups.map((provider) => (
              <div key={provider.id} role="group" aria-label={provider.name}>
                <SectionLabel>{provider.name}</SectionLabel>
                {provider.models.length === 0 && <p className="px-6 pb-2 text-[13px] text-mist">אין מודל שמתאים לחיפוש.</p>}
                {provider.models.map((model) => {
                  const chosen = settings.freeMode === 'manual' && settings.freeProvider === provider.id && settings.freeModel === model.id;
                  return (
                    <Row
                      key={model.id}
                      title={
                        <bdi dir="ltr" className="font-mono text-[13.5px] font-medium">
                          {model.id}
                        </bdi>
                      }
                      subtitle={model.id === provider.defaultModel ? 'ברירת המחדל של הספק' : null}
                      selected={chosen}
                      autoFocus={chosen}
                      onClick={() => choose({ freeMode: 'manual', freeProvider: provider.id, freeModel: model.id })}
                    />
                  );
                })}
              </div>
            ))}
          </>
        )}
      </div>
    </BottomSheet>
  );
}

/** A table of token and cost rows (by model or by stage) in the usage sheet. */
function UsageRows({ rows, name }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => (
        <li key={row.provider ? `${row.provider}/${row.model}` : row.role} className="flex items-center justify-between gap-3 py-2 text-[13.5px]">
          <span className="min-w-0 truncate">{name(row)}</span>
          <span className="shrink-0 text-graphite">
            <bdi dir="ltr">{formatTokens(row.input + row.output)}</bdi> טוקנים ·{' '}
            <bdi dir="ltr" className="font-medium text-ink">
              {row.priced === false ? '—' : formatUsd(row.cost)}
            </bdi>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The conversation's tokens and estimated cost: by model, by stage, what the handoff saved, and this month's total. */
export function UsageSheet({ open, onClose, conversationId }) {
  const [state, setState] = useState({ status: 'idle', data: null, error: null });
  useEffect(() => {
    if (!open || !conversationId) return undefined;
    const controller = new AbortController();
    setState((current) => ({ ...current, status: 'loading', error: null }));
    request(`/chat/conversations/${conversationId}/usage`, { signal: controller.signal }).then(
      (data) => setState({ status: 'ready', data, error: null }),
      (error) => {
        if (error.name !== 'AbortError') setState({ status: 'error', data: null, error: error.message });
      },
    );
    return () => controller.abort();
  }, [open, conversationId]);
  const usage = state.data?.usage;
  return (
    <BottomSheet open={open} onClose={onClose} id="usage" title="שימוש ועלות">
      <div className="px-6 pb-4">
        {!usage && state.status !== 'error' && <p className="py-4 text-[13.5px] text-mist">טוען…</p>}
        {state.status === 'error' && <p className="py-4 text-[13.5px] text-danger">{state.error}</p>}
        {usage && (
          <>
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
              <div>
                <p className="text-[12.5px] text-mist">עלות משוערת של השיחה</p>
                <p className="text-[28px] font-semibold tracking-tight">
                  <bdi dir="ltr">
                    {usage.estimated ? '~' : ''}
                    {formatUsd(usage.cost)}
                  </bdi>
                </p>
              </div>
              <p className="pb-1.5 text-[13px] text-graphite">
                <bdi dir="ltr">{formatTokens(usage.input)}</bdi> קלט · <bdi dir="ltr">{formatTokens(usage.output)}</bdi> פלט
                {usage.cached > 0 && (
                  <>
                    {' '}
                    (<bdi dir="ltr">{formatTokens(usage.cached)}</bdi> מהמטמון)
                  </>
                )}
              </p>
            </div>
            {usage.saved >= 0.0001 && (
              <p className="mt-2 rounded-xl bg-sunken px-3 py-2 text-[13px] leading-relaxed">
                העברה חסכונית והמשכים במודל זול חסכו כ-<bdi dir="ltr">{formatUsd(usage.saved)}</bdi> בשיחה הזו.
              </p>
            )}
            {usage.calls === 0 && <p className="mt-3 text-[13.5px] text-graphite">עוד אין בשיחה קריאות למודלים.</p>}
            {usage.byModel.length > 0 && (
              <>
                <SectionLabel>לפי מודל</SectionLabel>
                <UsageRows rows={usage.byModel} name={(row) => <bdi dir="ltr">{row.label}</bdi>} />
                <SectionLabel>לפי שלב</SectionLabel>
                <UsageRows rows={usage.byRole} name={(row) => row.label} />
              </>
            )}
            <div className="mt-4 border-t border-line pt-3 text-[12.5px] leading-relaxed text-mist">
              <p className="text-graphite">
                החודש: <bdi dir="ltr">{formatUsd(state.data.month.cost)}</bdi> · כל השיחות: <bdi dir="ltr">{formatUsd(state.data.all.cost)}</bdi>
              </p>
              <p className="mt-1">
                הערכה בדולרים לפי מחירוני הספקים ({new Date(state.data.pricesChecked).toLocaleDateString('he-IL')}), כולל טוקני חשיבה ומטמון. DeepSeek זול בחצי מחוץ לשעות השיא, והסביבה החינמית לא עולה כסף.
                {usage.estimated && ' חלק מהקריאות לא דווחו על ידי הספק, והן הוערכו לפי אורך הטקסט.'}
                {usage.unpriced > 0 && ` לחלק מהמודלים (${usage.unpriced} קריאות) אין מחיר ידוע.`}
              </p>
            </div>
          </>
        )}
      </div>
    </BottomSheet>
  );
}

/** project_state.md: the conversation's memory. */
export function MemorySheet({ open, onClose, memory, conversationId, onCompact, busy }) {
  const left = memory ? Math.max(0, memory.compactEvery - memory.turnsSince) : null;
  return (
    <BottomSheet open={open} onClose={onClose} id="memory" title="זיכרון השיחה">
      <div className="px-6 pb-2">
        <p className="text-[13.5px] leading-relaxed text-graphite">
          כל {memory?.compactEvery ?? 10} תורות, מודל מהיר מסכם את השיחה לקובץ <bdi dir="ltr">project_state.md</bdi>, ומאז מקבלים המודלים רק את הקובץ ואת
          ההודעות האחרונות. ההודעות עצמן נשארות בשיחה.
        </p>
        {memory && (
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-mist">
            {memory.updatedAt ? <span>עודכן {formatRelative(memory.updatedAt)}{memory.by ? ` על ידי ${memory.by.name}` : ''}</span> : <span>עדיין לא עודכן</span>}
            {memory.compactions > 0 && <span>{memory.compactions === 1 ? 'סוכם פעם אחת' : `סוכם ${memory.compactions} פעמים`}</span>}
            <span>{left <= 1 ? 'העדכון הבא אחרי התשובה הבאה' : `העדכון הבא בעוד ${left} תורות`}</span>
          </p>
        )}
      </div>
      <div className="mx-6 my-3 max-h-[46dvh] overflow-y-auto rounded-2xl border border-line bg-sunken/40 px-4 py-3">
        {memory?.state ? (
          <Suspense fallback={<pre className="text-[13px] whitespace-pre-wrap">{memory.state}</pre>}>
            <ChatMarkdown text={memory.state} />
          </Suspense>
        ) : (
          <p className="py-6 text-center text-[14px] text-graphite">הזיכרון עדיין ריק.</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2 px-6 pb-2">
        {conversationId && memory?.state && (
          <Button as="a" href={resourceUrl(`/api/chat/conversations/${conversationId}/memory?download=1`)} download size="sm" icon={Download}>
            הורדת project_state.md
          </Button>
        )}
        {conversationId && (
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={onCompact} disabled={busy}>
            {busy ? 'מעדכן…' : 'עדכון עכשיו'}
          </Button>
        )}
      </div>
    </BottomSheet>
  );
}

/** Pick one of your GitHub repositories to reference in the message. */
export function RepoSheet({ open, onClose, github, onPick, onOpenSettings }) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);
  const connected = Boolean(github.connection.data?.connected);
  const repos = github.repos.filter((repo) => !query || repo.github.fullName.toLowerCase().includes(query.toLowerCase())).slice(0, 40);
  return (
    <BottomSheet open={open} onClose={onClose} id="repos" title="צירוף מאגר GitHub">
      <p className="px-6 pb-3 text-[13.5px] leading-relaxed text-graphite">
        המאגר נכתב בהודעה כ-<bdi dir="ltr">@owner/repo</bdi>, ועץ הקבצים וה-README שלו נשלחים למודל. להוספת קובץ מסוים: <bdi dir="ltr">@owner/repo:path/to/file</bdi>.
      </p>
      {!connected ? (
        <div className="px-6 pb-4">
          <p className="text-[14px] text-graphite">כדי לבחור מהרשימה צריך לחבר את GitHub. אפשר גם להקליד את שם המאגר ישירות בהודעה.</p>
          <Button className="mt-3" size="sm" icon={Settings} onClick={onOpenSettings}>
            חיבור בהגדרות
          </Button>
        </div>
      ) : (
        <>
          <div className="px-6 pb-2">
            <label className="flex h-10 items-center gap-2 rounded-full border border-line-strong px-3 focus-within:border-graphite">
              <Search size={15} className="text-mist" aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="חיפוש מאגר" aria-label="חיפוש מאגר" className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-mist" data-autofocus />
            </label>
          </div>
          {repos.map((repo) => (
            <Row
              key={repo.id}
              icon={FolderGit2}
              title={<bdi dir="ltr" className="text-[14.5px]">{repo.github.fullName}</bdi>}
              subtitle={repo.analyzed ? repo.title : repo.github.description || null}
              tag={repo.github.private ? 'פרטי' : null}
              onClick={() => {
                onPick(repo.github.fullName);
                onClose();
              }}
            />
          ))}
        </>
      )}
    </BottomSheet>
  );
}

/**
 * Shares a conversation as Markdown: through the device's share sheet where the
 * browser has one, by copying it, or as a downloaded .md file. The messages
 * are loaded from the server when the sheet opens.
 */
export function ShareSheet({ open, onClose, conversation }) {
  const toast = useToast();
  const [state, setState] = useState({ status: 'idle', markdown: '', count: 0, error: null });
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useEffect(() => {
    if (!open || !conversation) return undefined;
    const controller = new AbortController();
    setState({ status: 'loading', markdown: '', count: 0, error: null });
    request(`/chat/conversations/${conversation.id}`, { signal: controller.signal })
      .then(({ conversation: full }) => setState({ status: 'ready', markdown: conversationMarkdown(full), count: full.messages.length, error: null }))
      .catch((error) => {
        if (!controller.signal.aborted) setState({ status: 'error', markdown: '', count: 0, error: error.message });
      });
    return () => controller.abort();
  }, [open, conversation]);

  const title = conversation?.title || 'שיחה חדשה';
  const finish = (message) => {
    toast.success(message);
    onClose();
  };
  const shareNative = async () => {
    try {
      await navigator.share({ title, text: state.markdown });
      onClose();
    } catch (error) {
      if (error?.name !== 'AbortError') toast.error('השיתוף נכשל. אפשר להעתיק את השיחה במקום.');
    }
  };
  const copy = async () => {
    try {
      await copyText(state.markdown);
      finish('השיחה הועתקה');
    } catch {
      toast.error('ההעתקה נכשלה. נסו להוריד את השיחה כקובץ.');
    }
  };
  const download = () => {
    downloadText(`${fileNameOf(title)}.md`, state.markdown);
    finish('הקובץ הורד');
  };

  return (
    <BottomSheet open={open} onClose={onClose} id="share-conversation" title="שיתוף השיחה">
      <p className="px-6 pb-2 text-[13.5px] leading-snug text-graphite">
        <bdi dir="auto" className="font-medium text-ink">
          {title}
        </bdi>
        {state.status === 'ready' && <> ({pluralize(state.count, 'הודעה אחת', 'הודעות')})</>}
      </p>
      {state.status === 'loading' && (
        <p className="px-6 py-4 text-[14px] text-graphite" role="status">
          מכין את השיחה לשיתוף…
        </p>
      )}
      {state.status === 'error' && (
        <p className="px-6 py-4 text-[14px] text-danger" role="alert">
          השיחה לא נטענה: {state.error}
        </p>
      )}
      {state.status === 'ready' && (
        <>
          {canShare && <Row icon={Share2} title="שיתוף…" subtitle="לאפליקציה אחרת במכשיר" onClick={shareNative} autoFocus />}
          <Row icon={Copy} title="העתקה" subtitle="כל ההודעות כטקסט Markdown, להדבקה בכל מקום" onClick={copy} autoFocus={!canShare} />
          <Row
            icon={Download}
            title="הורדת קובץ"
            subtitle={
              <>
                קובץ <bdi dir="ltr">.md</bdi> עם כל ההודעות
              </>
            }
            onClick={download}
          />
          <p className="px-6 pt-2 pb-1 text-[12.5px] leading-snug text-mist">קבצים מצורפים לא נכללים, רק השמות שלהם.</p>
        </>
      )}
    </BottomSheet>
  );
}
