import { Copy, ExternalLink, Globe, LoaderCircle, Monitor, RotateCw, Smartphone, SquareTerminal, Tablet } from 'lucide-react';
import { Suspense, lazy, useEffect, useState } from 'react';
import { Button, IconButton } from '../../../components/ui/Button.jsx';
import { useToast } from '../../../components/ui/Toaster.jsx';
import { copyText } from '../../../lib/clipboard.js';
import { cx } from '../../../lib/cx.js';
import { Loading, Notice, RetryButton } from './parts.jsx';
import { useFileContent, usePreviewPlan } from './projectFiles.js';
import { sourceOf } from './sources.js';
import { resourceUrl } from '../../../lib/api.js';

const MarkdownView = lazy(() => import('./MarkdownView.jsx'));

// A site on its own origin (p-<id>.localhost, or a repository's website) may keep its own storage.
// The ZIP fallback runs on the dashboard's origin, so it gets an opaque origin instead (no allow-same-origin).
const OWN_ORIGIN_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads';
const FALLBACK_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads';

const DEVICES = [
  { id: 'desktop', label: 'מחשב', icon: Monitor, width: null },
  { id: 'tablet', label: 'טאבלט', icon: Tablet, width: 820 },
  { id: 'mobile', label: 'נייד', icon: Smartphone, width: 390 },
];

/**
 * ZIP projects: the live site from the archive, when it has one.
 * GitHub repositories: the repository's website (its homepage or GitHub Pages).
 * Otherwise: why there's no live site, how to run the project, and its README.
 */
export default function PreviewTab({ project }) {
  const source = sourceOf(project);
  const plan = usePreviewPlan(source);
  if (plan.status === 'loading') return <Loading label="בודקים איך אפשר להציג את הפרויקט…" />;
  if (plan.status === 'error') {
    return (
      <Notice tone="error" title="טעינת התצוגה המקדימה נכשלה" actions={<RetryButton onClick={plan.retry} />}>
        {plan.error.message}
      </Notice>
    );
  }
  if (plan.data.mode === 'site') return <SitePreview project={project} plan={plan.data} />;
  if (plan.data.mode === 'external') return <ExternalPreview project={project} source={source} plan={plan.data} />;
  return <RuntimeNotice source={source} plan={plan.data} />;
}

/** True when the browser reaches the preview's own origin (browsers resolve *.localhost to this computer). */
async function canReach(originUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    await fetch(`${originUrl}__stash/ping`, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function SitePreview({ project, plan }) {
  const [target, setTarget] = useState(null);
  useEffect(() => {
    let active = true;
    canReach(plan.originUrl).then((ok) => {
      if (active) setTarget(ok ? { url: plan.originUrl, isolated: true } : { url: resourceUrl(plan.pathUrl), isolated: false });
    });
    return () => {
      active = false;
    };
  }, [plan.originUrl, plan.pathUrl]);

  const note =
    target && !target.isolated ? (
      <>
        תצוגה בסיסית: הדפדפן לא פותח כתובות <bdi>*.localhost</bdi>, ולכן אתרים שטוענים קבצים בנתיבים מוחלטים עלולים להיטען באופן חלקי.
      </>
    ) : null;
  return (
    <LiveFrame
      project={project}
      url={target?.url ?? null}
      sandbox={target?.isolated ? OWN_ORIGIN_SANDBOX : FALLBACK_SANDBOX}
      label="תצוגה חיה של"
      place={plan.entry}
      note={note}
    />
  );
}

function ExternalPreview({ project, source, plan }) {
  if (plan.framable === false) {
    return (
      <div className="h-full overflow-y-auto overscroll-contain">
        <Banner icon={Globe} title="האתר לא מאפשר להציג אותו כאן">
          <p>
            האתר <bdi dir="ltr" className="text-ink">{plan.url}</bdi> חוסם הצגה בתוך אתרים אחרים, ולכן אפשר לפתוח אותו רק בכרטיסייה נפרדת.
          </p>
          <Button as="a" href={plan.url} target="_blank" rel="noopener noreferrer" icon={ExternalLink} className="mt-4">
            פתיחת האתר בכרטיסייה חדשה
          </Button>
        </Banner>
        <ReadmeBlock source={source} readme={plan.readme} />
      </div>
    );
  }
  return (
    <LiveFrame
      project={project}
      url={plan.url}
      sandbox={OWN_ORIGIN_SANDBOX}
      label={plan.site === 'pages' ? 'GitHub Pages:' : 'אתר המאגר:'}
      place={plan.url}
      note={plan.framable === null ? 'לא הצלחנו לבדוק מראש אם האתר מאפשר להציג אותו כאן. אם הוא לא נטען, פתחו אותו בכרטיסייה חדשה.' : null}
    />
  );
}

/** What is shown, device widths, reload and open-in-new-tab, above the site's iframe. */
function LiveFrame({ project, url, sandbox, label, place, note }) {
  const [device, setDevice] = useState('desktop');
  const [reloads, setReloads] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const width = DEVICES.find((item) => item.id === device).width;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2 sm:px-5">
        <p className="flex min-w-0 flex-1 items-center gap-2 text-[13.5px] text-graphite">
          <span className="size-2 shrink-0 rounded-full bg-ok" aria-hidden="true" />
          <span className="shrink-0">{label}</span>
          <bdi dir="ltr" className="truncate font-medium text-ink">{place}</bdi>
        </p>
        <DeviceToggle value={device} onChange={setDevice} />
        <IconButton
          label="טעינה מחדש"
          onClick={() => {
            setLoaded(false);
            setReloads((count) => count + 1);
          }}
        >
          <RotateCw size={16} aria-hidden="true" />
        </IconButton>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="פתיחה בכרטיסייה חדשה"
            title="פתיחה בכרטיסייה חדשה"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-graphite transition-colors hover:bg-sunken hover:text-ink"
          >
            <ExternalLink size={16} aria-hidden="true" />
          </a>
        )}
      </div>
      {note && <p className="shrink-0 border-b border-line bg-sunken/60 px-5 py-2 text-[13px] leading-relaxed text-graphite">{note}</p>}
      <div className="relative min-h-0 flex-1 bg-sunken p-3 sm:p-4">
        <div className="mx-auto h-full transition-[max-width] duration-300 ease-out" style={{ maxWidth: width ?? '100%' }}>
          {url && (
            <iframe
              key={reloads}
              src={url}
              title={`תצוגה מקדימה: ${project.title}`}
              sandbox={sandbox}
              referrerPolicy="no-referrer"
              onLoad={() => setLoaded(true)}
              className="size-full rounded-xl border border-line bg-white shadow-[0_1px_3px_rgb(13_16_22/0.08)]"
            />
          )}
        </div>
        {!loaded && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="flex items-center gap-2 rounded-full bg-surface px-4 py-2 text-[13.5px] text-graphite shadow-[0_4px_16px_-4px_rgb(13_16_22/0.2)]">
              <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
              טעינת התצוגה המקדימה…
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function DeviceToggle({ value, onChange }) {
  return (
    <div role="radiogroup" aria-label="רוחב התצוגה" className="flex shrink-0 rounded-full bg-sunken p-0.5">
      {DEVICES.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          aria-label={label}
          title={label}
          onClick={() => onChange(id)}
          className={cx(
            'inline-flex h-7 w-9 items-center justify-center rounded-full transition-colors',
            value === id ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(13_16_22/0.12)]' : 'text-graphite hover:text-ink',
          )}
        >
          <Icon size={15} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

function Banner({ icon: Icon, title, children }) {
  return (
    <div className="border-b border-line bg-sunken/50 px-5 py-6 sm:px-8">
      <div className="flex max-w-3xl gap-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-surface text-graphite">
          <Icon size={20} aria-hidden="true" />
        </span>
        <div className="min-w-0 text-[15px] leading-relaxed text-graphite">
          <h3 className="font-wide text-[19px] leading-snug font-bold text-ink">{title}</h3>
          <div className="mt-1.5">{children}</div>
        </div>
      </div>
    </div>
  );
}

function RuntimeNotice({ source, plan }) {
  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <Banner icon={SquareTerminal} title={plan.title}>
        <p>{plan.reason}</p>
        {plan.hints.length > 0 && (
          <div className="mt-5">
            <p className="text-[13.5px] font-medium text-ink">כך מריצים את הפרויקט במחשב:</p>
            <ol className="mt-3 space-y-3.5">
              {plan.hints.map((hint, index) => (
                <HintRow key={index} index={index + 1} hint={hint} />
              ))}
            </ol>
          </div>
        )}
      </Banner>
      <ReadmeBlock source={source} readme={plan.readme} />
    </div>
  );
}

function ReadmeBlock({ source, readme }) {
  const content = useFileContent(source, readme, Boolean(readme));
  const isMarkdown = readme && (/\.(md|markdown|mdx)$/i.test(readme) || !readme.split('/').pop().includes('.'));
  return (
    <div className="px-5 py-7 sm:px-8">
      {!readme && <p className="text-[14.5px] text-graphite">לא נמצא README להצגה.</p>}
      {readme && content.status === 'loading' && <Loading label="טעינת ה-README…" />}
      {readme && content.status === 'error' && <p className="bidi-plain text-[14.5px] text-danger" dir="auto">{content.error.message}</p>}
      {readme &&
        content.status === 'ready' &&
        (isMarkdown ? (
          <Suspense fallback={<Loading />}>
            <MarkdownView text={content.data.text} source={source} filePath={readme} />
          </Suspense>
        ) : (
          <pre className="max-w-[80ch] font-sans text-[15px] leading-relaxed whitespace-pre-wrap" dir="auto">
            {content.data.text}
          </pre>
        ))}
    </div>
  );
}

/** One step to run the project: a Hebrew label, then the command as a left-to-right terminal line. */
function HintRow({ index, hint }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await copyText(hint.command);
      toast.success('הפקודה הועתקה');
    } catch {
      toast.error('ההעתקה נכשלה: הדפדפן חסם את הגישה ללוח.');
    }
  };
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-surface font-narrow text-[12.5px] text-graphite">{index}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] text-ink">{hint.label}</p>
        {hint.command && (
          <div dir="ltr" className="mt-1.5 flex max-w-xl items-center gap-2 rounded-lg border border-line bg-surface py-1 ps-3 pe-1 text-left">
            <span className="font-mono text-[13px] text-mist select-none" aria-hidden="true">
              $
            </span>
            <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[13px] whitespace-pre text-ink">{hint.command}</code>
            <IconButton label="העתקת הפקודה" onClick={copy}>
              <Copy size={13} aria-hidden="true" />
            </IconButton>
          </div>
        )}
      </div>
    </li>
  );
}
