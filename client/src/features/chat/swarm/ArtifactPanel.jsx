/**
 * A generated project, live: the last screen of the development team's dashboard, for the project's latest
 * version. Two tabs: the project running (its live preview, served from an origin of its own, in a frame at
 * desktop, tablet or phone width) and its code (this version's files, highlighted, to copy or download). Below
 * them, "what would you like to change?" asks the team to edit this project; the new version takes this panel's
 * place when it's ready. Both tabs stay mounted, so switching doesn't reload the running app. The frame renders at
 * the chosen device's width (the app's layout and media queries are that device's) and is shrunk to fit the column.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Code2, Copy, Download, ExternalLink, FileCode2, Folder, LoaderCircle, Monitor, Play, RefreshCw, RotateCcw, Send, Smartphone, Tablet } from 'lucide-react';
import { request, resourceUrl } from '../../../lib/api.js';
import { copyText } from '../../../lib/clipboard.js';
import { cx } from '../../../lib/cx.js';
import { highlightToHtml, languageOf } from '../../projects/details/highlight.js';
import { useArtifacts } from './artifactContext.js';
import { filesText } from './pipelineState.js';

const VIEWPORTS = [
  { id: 'desktop', label: 'מחשב', icon: Monitor, width: 1280 },
  { id: 'tablet', label: 'טאבלט', icon: Tablet, width: 768 },
  { id: 'mobile', label: 'טלפון', icon: Smartphone, width: 390 },
];
const WAITING = new Set(['starting', 'updating']);
const FRAME_HEIGHT = 520;
const HIGHLIGHT_LIMIT = 200_000;
const MAIN_FILES = /(^|\/)(src\/)?(App|main|index)\.(jsx|tsx|js|ts|vue|svelte)$|(^|\/)index\.html$/;

/** The preview's state: re-checked on mount (a saved "live" may have ended), every 2 seconds while it starts, and when its time is up. */
function usePreview(base, saved, enabled) {
  const [preview, setPreview] = useState(saved);
  const [canRevive, setCanRevive] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const data = await request(`${base}/preview`);
      setPreview(data.preview);
      setCanRevive(Boolean(data.sandbox));
    } catch {
      // Keep what's shown; the next check tries again.
    }
  }, [base]);
  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);
  useEffect(() => {
    if (!enabled || !preview) return undefined;
    // Using the preview keeps it up longer, so at the end of its time it's asked again rather than assumed gone.
    const wait = WAITING.has(preview.status) ? 2_000 : preview.status === 'live' && preview.expiresAt ? Math.max(5_000, Date.parse(preview.expiresAt) - Date.now() + 1_000) : null;
    if (wait === null) return undefined;
    const timer = setTimeout(refresh, wait);
    return () => clearTimeout(timer);
  }, [enabled, preview, refresh]);
  const revive = useCallback(async () => {
    setPreview((current) => ({ ...current, status: 'starting', reason: '' }));
    try {
      setPreview((await request(`${base}/preview`, { method: 'POST' })).preview);
    } catch (error) {
      setPreview((current) => ({ ...current, status: 'failed', reason: error.message }));
    }
  }, [base]);
  return { preview, canRevive, revive };
}

/** The width of an element, followed as it changes (a callback ref: the element may appear later). */
function useWidth() {
  const [width, setWidth] = useState(0);
  const observer = useRef(null);
  const ref = useCallback((element) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.current.observe(element);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}

function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function StatusBox({ tone = 'idle', children }) {
  return (
    <div className={cx('flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-xl border px-4 py-8 text-center text-[13.5px]', tone === 'fail' ? 'border-fix/40 bg-fix/5' : 'border-line bg-sunken')}>
      {children}
    </div>
  );
}

function PreviewTab({ preview, canRevive, onRevive }) {
  const [viewport, setViewport] = useState('desktop');
  const [reloads, setReloads] = useState(0);
  const [stage, available] = useWidth();
  const now = useMinuteClock();
  const status = preview?.status ?? 'expired';
  const reviveButton = (label) =>
    canRevive && (
      <button type="button" onClick={onRevive} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-gen px-4 text-[13.5px] font-semibold text-ink transition hover:brightness-105">
        <Play size={15} aria-hidden="true" />
        {label}
      </button>
    );
  if (status === 'starting') {
    return (
      <StatusBox>
        <LoaderCircle size={22} className="text-gen motion-safe:animate-spin" aria-hidden="true" />
        <p className="font-semibold">מפעיל את התצוגה החיה…</p>
        <p className="text-[12.5px] text-mist">התקנה בסביבה המבודדת והפעלה של שרת הפיתוח. זה לוקח עד דקה או שתיים.</p>
      </StatusBox>
    );
  }
  if (status === 'failed' || status === 'expired' || status === 'unavailable' || status === 'off') {
    const text = {
      failed: 'התצוגה החיה לא עלתה.',
      expired: 'התצוגה החיה נסגרה אחרי זמן בלי שימוש, כדי לפנות את הסביבה המבודדת.',
      unavailable: 'לפרויקט הזה אין תצוגה חיה.',
      off: 'תצוגה חיה דורשת סביבה מבודדת (Docker או E2B) שהופעלה בשרת לחשבון הזה.',
    }[status];
    return (
      <StatusBox tone={status === 'failed' ? 'fail' : 'idle'}>
        <p className="font-semibold">{text}</p>
        {preview?.reason && (
          <pre dir="auto" className="max-h-40 w-full max-w-xl overflow-auto whitespace-pre-wrap rounded-lg bg-surface px-3 py-2 text-start font-mono text-[12px] leading-5 text-graphite">
            {preview.reason}
          </pre>
        )}
        {status !== 'unavailable' && status !== 'off' && reviveButton(status === 'failed' ? 'נסו שוב' : 'הפעלה מחדש')}
        {status === 'expired' && !canRevive && <p className="text-[12.5px] text-mist">הקוד זמין בלשונית „קוד״ ובקובץ ה-ZIP.</p>}
      </StatusBox>
    );
  }
  const device = VIEWPORTS.find((item) => item.id === viewport);
  // The app gets the device's width; a column narrower than that shows it shrunk (inside the frame's 1px border).
  const inner = Math.max(0, available - 2);
  const scale = inner ? Math.min(1, inner / device.width) : 1;
  // Against the time now, not the clock's last tick: using the preview renews it, and a stale tick shows a minute too many.
  const left = preview.expiresAt ? Math.max(0, Math.ceil((Date.parse(preview.expiresAt) - Math.max(now, Date.now())) / 60_000)) : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="רוחב התצוגה" className="inline-flex rounded-full border border-line bg-sunken p-0.5">
          {VIEWPORTS.map(({ id, label, icon: Icon, width: size }) => (
            <button
              key={id}
              type="button"
              aria-pressed={viewport === id}
              title={size ? `${label} · ${size}px` : label}
              onClick={() => setViewport(id)}
              className={cx('inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition', viewport === id ? 'bg-surface text-ink shadow-sm' : 'text-graphite hover:text-ink')}
            >
              <Icon size={15} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
        <span dir="ltr" title="הרוחב שהפרויקט רואה, וכמה התצוגה הוקטנה כדי להיכנס" className="text-[11.5px] text-mist tabular-nums">
          {device.width}px{scale < 1 ? ` · ${Math.round(scale * 100)}%` : ''}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5 text-[12px] text-mist" role="status">
            <span className={cx('size-2 rounded-full', status === 'live' ? 'bg-pass' : 'bg-gen motion-safe:animate-pulse')} aria-hidden="true" />
            {status === 'updating' ? 'מתעדכנת…' : left !== null ? `פעילה · נסגרת בעוד ${left <= 1 ? 'דקה' : `${left} דק׳`} בלי שימוש` : 'פעילה'}
          </span>
          <button type="button" onClick={() => setReloads((count) => count + 1)} title="רענון התצוגה" className="grid size-8 place-items-center rounded-full text-graphite transition hover:bg-sunken hover:text-ink">
            <RefreshCw size={15} aria-hidden="true" />
            <span className="sr-only">רענון התצוגה</span>
          </button>
          <a href={preview.url} target="_blank" rel="noopener noreferrer" title="פתיחה בכרטיסייה חדשה" className="grid size-8 place-items-center rounded-full text-graphite transition hover:bg-sunken hover:text-ink">
            <ExternalLink size={15} aria-hidden="true" />
            <span className="sr-only">פתיחה בכרטיסייה חדשה</span>
          </a>
        </div>
      </div>
      <div className="rounded-xl border border-line bg-sunken p-2">
        <div ref={stage} dir="ltr">
          <div
            className="relative mx-auto max-w-full overflow-hidden rounded-lg border border-line bg-white shadow-sm transition-[width] duration-300 ease-out"
            style={{ width: Math.round(device.width * scale) + 2, height: FRAME_HEIGHT + 2 }}
          >
            {/* Its own origin (s-<token>.localhost): the app can't reach Stash's storage, cookies or API. */}
            <iframe
              key={`${preview.url}#${preview.version}#${reloads}`}
              src={preview.url}
              title="התצוגה החיה של הפרויקט"
              className="block border-0 bg-white"
              style={{ width: device.width, height: Math.round(FRAME_HEIGHT / scale), transform: scale < 1 ? `scale(${scale})` : undefined, transformOrigin: '0 0' }}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
              referrerPolicy="no-referrer"
            />
            {status === 'updating' && (
              <div dir="rtl" className="absolute inset-0 grid place-items-center bg-surface/70 backdrop-blur-[1px]">
                <p className="inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1.5 text-[13px] font-semibold shadow-sm">
                  <LoaderCircle size={15} className="text-gen motion-safe:animate-spin" aria-hidden="true" />
                  מעדכן את התצוגה…
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The files as a tree (folders first), left to right like paths. */
function CodeTree({ files, selected, onSelect }) {
  const rows = useMemo(() => {
    const root = { folders: new Map(), files: [] };
    for (const file of files) {
      const parts = file.path.split('/');
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
        node = node.folders.get(part);
      }
      node.files.push({ ...file, name: parts.at(-1) });
    }
    const flat = [];
    const walk = (node, depth, prefix) => {
      for (const [name, child] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
        flat.push({ id: `${prefix}${name}/`, name, depth, folder: true });
        walk(child, depth + 1, `${prefix}${name}/`);
      }
      for (const file of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) flat.push({ id: file.path, name: file.name, depth, purpose: file.purpose });
    };
    walk(root, 0, '');
    return flat;
  }, [files]);
  return (
    <ul dir="ltr" aria-label="קבצי הפרויקט" className="max-h-44 overflow-auto rounded-xl border border-line bg-sunken py-1.5 font-mono text-[12.5px] leading-7 md:max-h-[560px]">
      {rows.map((row) =>
        row.folder ? (
          <li key={row.id} className="flex items-center gap-1.5 px-2 font-semibold whitespace-nowrap text-graphite" style={{ paddingLeft: `${8 + row.depth * 14}px` }}>
            <Folder size={14} className="shrink-0 text-plan" aria-hidden="true" />
            {row.name}/
          </li>
        ) : (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onSelect(row.id)}
              aria-current={selected === row.id ? 'true' : undefined}
              title={row.purpose || row.id}
              className={cx('flex w-full items-center gap-1.5 px-2 text-start whitespace-nowrap transition', selected === row.id ? 'bg-plan/15 font-semibold text-ink' : 'text-graphite hover:bg-surface hover:text-ink')}
              style={{ paddingLeft: `${8 + row.depth * 14}px` }}
            >
              <FileCode2 size={14} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{row.name}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

function CodeTab({ base, version }) {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    request(`${base}?version=${version}`)
      .then(({ artifact }) => {
        if (cancelled) return;
        setFiles(artifact.files);
        setSelected((artifact.files.find((file) => MAIN_FILES.test(file.path)) ?? artifact.files.find((file) => !file.path.endsWith('package.json')) ?? artifact.files[0])?.path ?? null);
      })
      .catch((failure) => !cancelled && setError(failure.message));
    return () => {
      cancelled = true;
    };
  }, [base, version]);
  const file = files?.find((item) => item.path === selected) ?? null;
  const { language, label } = file ? languageOf(file.path) : { language: null, label: null };
  const html = useMemo(() => (file && file.content.length <= HIGHLIGHT_LIMIT ? highlightToHtml(file.content, language) : null), [file, language]);
  useEffect(() => setCopied(false), [selected]);
  if (error) return <StatusBox tone="fail">{error}</StatusBox>;
  if (!files) {
    return (
      <StatusBox>
        <LoaderCircle size={20} className="text-plan motion-safe:animate-spin" aria-hidden="true" />
        טוען את הקבצים…
      </StatusBox>
    );
  }
  const copy = async () => {
    await copyText(file.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_600);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = file.path.split('/').pop();
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  return (
    <div className="grid gap-2 md:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
      <CodeTree files={files} selected={selected} onSelect={setSelected} />
      {file && (
        <div className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface">
          <div className="flex items-center justify-between gap-2 border-b border-line bg-sunken px-3 py-1.5">
            <p className="min-w-0 truncate text-[12.5px]">
              <bdi dir="ltr" className="font-mono font-semibold">
                {file.path}
              </bdi>
              {label && <span className="ms-2 text-mist">{label}</span>}
            </p>
            <div className="flex shrink-0 items-center gap-1">
              <button type="button" onClick={copy} className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium text-graphite transition hover:bg-surface hover:text-ink">
                {copied ? <Check size={14} className="text-pass" aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                <span aria-live="polite">{copied ? 'הועתק' : 'העתקה'}</span>
              </button>
              <button type="button" onClick={download} className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium text-graphite transition hover:bg-surface hover:text-ink">
                <Download size={14} aria-hidden="true" />
                הורדה
              </button>
            </div>
          </div>
          <pre dir="ltr" tabIndex={0} aria-label={`הקוד של ${file.path}`} className="max-h-[520px] overflow-auto p-3 text-[12.5px] leading-6">
            {html === null ? <code>{file.content}</code> : <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />}
          </pre>
        </div>
      )}
    </div>
  );
}

function EditBox({ busy, onSend }) {
  const [text, setText] = useState('');
  const submit = () => {
    const content = text.trim();
    if (!content || busy) return;
    onSend(content);
    setText('');
  };
  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex items-end gap-2 rounded-2xl border border-line bg-surface px-3 py-2 transition focus-within:border-plan/60"
      >
        <label htmlFor="artifact-change" className="sr-only">
          מה תרצו לשנות?
        </label>
        <textarea
          id="artifact-change"
          rows={1}
          dir="auto"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="מה תרצו לשנות? למשל: הוסיפו מצב כהה"
          className="field-sizing-content max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-6 outline-none placeholder:text-mist"
        />
        <button type="submit" disabled={busy || !text.trim()} className="grid size-9 shrink-0 place-items-center rounded-full bg-plan text-white transition enabled:hover:brightness-110 disabled:opacity-40">
          {busy ? <LoaderCircle size={16} className="motion-safe:animate-spin" aria-hidden="true" /> : <Send size={16} className="-scale-x-100" aria-hidden="true" />}
          <span className="sr-only">{busy ? 'הצוות עובד' : 'שליחת השינוי'}</span>
        </button>
      </form>
      <p className="mt-1.5 text-[12px] text-mist">הצוות משנה רק את הקבצים הנדרשים, בודק אותם, ומעדכן את התצוגה. כל שינוי נשמר כגרסה חדשה.</p>
    </div>
  );
}

export function ArtifactPanel({ artifact, preview: saved, bundle }) {
  const context = useArtifacts();
  const base = `/chat/conversations/${context.conversationId}/artifacts/${encodeURIComponent(artifact.id)}`;
  const previewable = Boolean(saved) && saved.status !== 'off';
  const { preview, canRevive, revive } = usePreview(base, saved, previewable);
  const [tab, setTab] = useState(previewable ? 'preview' : 'code');
  const [opened, setOpened] = useState(() => new Set([previewable ? 'preview' : 'code']));
  const choose = (id) => {
    setTab(id);
    setOpened((current) => new Set(current).add(id));
  };
  const tabs = [
    { id: 'preview', label: 'תצוגה חיה', icon: Play },
    { id: 'code', label: 'קוד', icon: Code2 },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="הפרויקט" className="inline-flex rounded-full border border-line bg-sunken p-0.5">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`artifact-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`artifact-panel-${id}`}
              onClick={() => choose(id)}
              className={cx('inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition', tab === id ? 'bg-surface text-ink shadow-sm' : 'text-graphite hover:text-ink')}
            >
              <Icon size={15} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-mist">גרסה {artifact.version}</span>
          {bundle?.url && (
            <a
              href={resourceUrl(bundle.url)}
              download
              title={bundle.name}
              aria-label={`הורדת הפרויקט (ZIP${bundle.files ? `, ${filesText(bundle.files)}` : ''})`}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-pass/50 bg-pass/10 px-3 text-[12.5px] font-semibold text-pass transition hover:bg-pass/15"
            >
              <Download size={14} aria-hidden="true" />
              ZIP
              {bundle.files ? <span className="font-medium opacity-80">· {filesText(bundle.files)}</span> : null}
            </a>
          )}
        </div>
      </div>
      <div role="tabpanel" id="artifact-panel-preview" aria-labelledby="artifact-tab-preview" hidden={tab !== 'preview'}>
        {opened.has('preview') && <PreviewTab preview={previewable ? preview : { status: 'off' }} canRevive={canRevive} onRevive={revive} />}
      </div>
      <div role="tabpanel" id="artifact-panel-code" aria-labelledby="artifact-tab-code" hidden={tab !== 'code'}>
        {opened.has('code') && <CodeTab base={base} version={artifact.version} />}
      </div>
      {context.canEdit ? (
        <EditBox busy={context.busy} onSend={(content) => context.edit(artifact.id, content)} />
      ) : (
        <p className="flex items-center gap-1.5 text-[12.5px] text-mist">
          <RotateCcw size={13} aria-hidden="true" />
          עריכת הפרויקט בשיחה זמינה בסביבת הפרימיום.
        </p>
      )}
    </div>
  );
}
