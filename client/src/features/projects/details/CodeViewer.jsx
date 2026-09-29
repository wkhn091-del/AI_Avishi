import { ArrowRight, Code2, Copy, Download, Eye, FileWarning, RefreshCw, WandSparkles, X } from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Button, IconButton } from '../../../components/ui/Button.jsx';
import { useToast } from '../../../components/ui/Toaster.jsx';
import { copyText } from '../../../lib/clipboard.js';
import { cx } from '../../../lib/cx.js';
import { formatBytes, formatRelative } from '../../../lib/format.js';
import { ListeningBars } from '../Fingerprint.jsx';
import { highlightToHtml, languageOf } from './highlight.js';
import { Loading, Notice, RetryButton, TechnicalDetail } from './parts.jsx';
import { explainFile, knownExplanation, useFileContent } from './projectFiles.js';
import { sourceOf } from './sources.js';

const MarkdownView = lazy(() => import('./MarkdownView.jsx'));

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const MARKDOWN = /\.(md|markdown|mdx)$/i;
const MAX_RENDERED_LINES = 20_000;

/**
 * One file of the archive: its path and actions, the AI explanation when
 * asked for, then the code (highlighted), rendered Markdown or the image.
 */
export function CodeViewer({ project, path, onBack }) {
  const toast = useToast();
  const source = sourceOf(project);
  const isImage = IMAGE.test(path);
  const isMarkdown = MARKDOWN.test(path);
  const content = useFileContent(source, path, !isImage);
  const { language, label } = languageOf(path);
  const [view, setView] = useState(isMarkdown ? 'rendered' : 'code');
  const [explanation, setExplanation] = useState(() => {
    const known = knownExplanation(source, path);
    return known ? { status: 'ready', data: known } : { status: 'idle' };
  });

  const segments = path.split('/');
  const folder = segments.slice(0, -1).join('/');
  const name = segments.at(-1);
  const downloadUrl = source.raw(path, { download: true });

  const explain = async (refresh = false) => {
    setExplanation({ status: 'loading' });
    try {
      setExplanation({ status: 'ready', data: await explainFile(source, path, refresh) });
    } catch (error) {
      setExplanation({ status: 'error', message: error.message, detail: error.details?.detail ?? null });
    }
  };

  const copy = async () => {
    try {
      await copyText(content.data.text);
      toast.success('תוכן הקובץ הועתק');
    } catch {
      toast.error('ההעתקה נכשלה: הדפדפן חסם את הגישה ללוח.');
    }
  };

  let body = null;
  if (isImage) {
    body = (
      <div className="checker grid h-full place-items-center overflow-auto p-6">
        <img src={source.raw(path)} alt={name} className="max-h-full max-w-full object-contain" />
      </div>
    );
  } else if (content.status === 'loading') {
    body = <Loading label="טעינת הקובץ…" />;
  } else if (content.status === 'error') {
    const code = content.error.code;
    const noCodeView = code === 'BINARY_FILE' || code === 'FILE_TOO_LARGE_TO_VIEW';
    body = noCodeView ? (
      <Notice
        icon={FileWarning}
        title={code === 'BINARY_FILE' ? 'אין תצוגת קוד לקובץ הזה' : 'הקובץ גדול מדי לתצוגה'}
        actions={
          <Button as="a" size="sm" href={downloadUrl} download icon={Download}>
            הורדת הקובץ
          </Button>
        }
      >
        {content.error.message}
      </Notice>
    ) : (
      <Notice tone="error" title="טעינת הקובץ נכשלה" actions={<RetryButton onClick={content.retry} />}>
        {content.error.message}
      </Notice>
    );
  } else if (content.status === 'ready') {
    body =
      isMarkdown && view === 'rendered' ? (
        <div className="h-full overflow-y-auto overscroll-contain px-5 py-6 sm:px-8">
          <Suspense fallback={<Loading />}>
            <MarkdownView text={content.data.text} source={source} filePath={path} />
          </Suspense>
        </div>
      ) : (
        <CodeBlock text={content.data.text} language={language} />
      );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 sm:px-5">
        <IconButton label="חזרה לרשימת הקבצים" onClick={onBack} className="sm:hidden">
          <ArrowRight size={18} aria-hidden="true" />
        </IconButton>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px]" title={path}>
            <bdi dir="ltr">
              {folder && <span className="text-mist">{folder}/</span>}
              <span className="font-semibold text-ink">{name}</span>
            </bdi>
          </p>
          <p className="flex gap-3 text-[12.5px] text-graphite">
            {label && <span>{label}</span>}
            {content.data?.size != null && <span className="font-narrow">{formatBytes(content.data.size)}</span>}
          </p>
        </div>

        {isMarkdown && content.status === 'ready' && <ViewToggle value={view} onChange={setView} />}
        {!isImage && content.status === 'ready' && (
          <Button size="sm" variant="primary" icon={WandSparkles} onClick={() => explain(false)} disabled={explanation.status === 'loading'}>
            הסבר קובץ זה
          </Button>
        )}
        {content.status === 'ready' && (
          <IconButton label="העתקת התוכן" onClick={copy}>
            <Copy size={16} aria-hidden="true" />
          </IconButton>
        )}
        <a
          href={downloadUrl}
          download
          aria-label="הורדת הקובץ"
          title="הורדת הקובץ"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-graphite transition-colors hover:bg-sunken hover:text-ink"
        >
          <Download size={16} aria-hidden="true" />
        </a>
      </div>

      {explanation.status !== 'idle' && (
        <ExplanationPanel
          state={explanation}
          onRetry={() => explain(false)}
          onRefresh={() => explain(true)}
          onClose={() => setExplanation({ status: 'idle' })}
        />
      )}

      <div className="relative min-h-0 flex-1">{body}</div>
    </div>
  );
}

function ViewToggle({ value, onChange }) {
  const options = [
    { id: 'rendered', label: 'תצוגה', icon: Eye },
    { id: 'code', label: 'קוד', icon: Code2 },
  ];
  return (
    <div role="radiogroup" aria-label="אופן התצוגה" className="flex shrink-0 rounded-full bg-sunken p-0.5">
      {options.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={cx(
            'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors',
            value === id ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(13_16_22/0.12)]' : 'text-graphite hover:text-ink',
          )}
        >
          <Icon size={14} aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

/** Highlighted code with a line-number gutter that stays put while scrolling sideways. Code is always left-to-right. */
function CodeBlock({ text, language }) {
  const { html, numbers, totalLines } = useMemo(() => {
    const lines = text.split('\n');
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    const shown = lines.slice(0, MAX_RENDERED_LINES);
    return {
      html: highlightToHtml(shown.join('\n'), language),
      numbers: shown.map((_, index) => index + 1).join('\n'),
      totalLines: lines.length,
    };
  }, [text, language]);

  return (
    <div className="h-full overflow-auto overscroll-contain" dir="ltr">
      <div className="flex min-w-max py-3 font-mono text-[13px] leading-[1.65]">
        <pre aria-hidden="true" className="sticky start-0 z-10 shrink-0 border-e border-line bg-surface ps-4 pe-3 text-end text-mist select-none">
          {numbers}
        </pre>
        <pre className="ps-4 pe-8 text-left">
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
      {totalLines > MAX_RENDERED_LINES && (
        <p dir="rtl" className="px-5 pb-4 text-[13px] text-graphite">
          מוצגות {MAX_RENDERED_LINES.toLocaleString('he-IL')} השורות הראשונות מתוך {totalLines.toLocaleString('he-IL')}.
        </p>
      )}
    </div>
  );
}

/** The AI's Hebrew explanation of the file: loading, error or result, with a way to ask again. */
function ExplanationPanel({ state, onRetry, onRefresh, onClose }) {
  return (
    <section aria-live="polite" aria-label="הסבר הקובץ" className="max-h-[45%] shrink-0 overflow-y-auto border-b border-line bg-sunken/60 px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-surface text-ink">
          <WandSparkles size={15} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold">מה הקובץ הזה עושה</h3>
          {state.status === 'loading' && (
            <>
              <div className="mt-3 w-44">
                <ListeningBars active height={18} count={26} />
              </div>
              <ExplainProgress />
            </>
          )}
          {state.status === 'error' && (
            <>
              <p className="bidi-plain mt-1 text-[14px] leading-relaxed text-danger" dir="auto">
                {state.message}
              </p>
              {state.detail && <TechnicalDetail className="mt-1.5">{state.detail}</TechnicalDetail>}
              <div className="mt-3">
                <RetryButton onClick={onRetry} />
              </div>
            </>
          )}
          {state.status === 'ready' && (
            <>
              {/* Always right-to-left: explanations are Hebrew (the server enforces it), even when a sentence starts with a code name. */}
              <p className="mt-1 max-w-[80ch] text-[14.5px] leading-relaxed" dir="rtl">
                {state.data.summary}
              </p>
              {state.data.points.length > 0 && (
                <ul className="mt-2.5 max-w-[80ch] list-disc space-y-1 ps-5 text-[14px] leading-relaxed text-graphite">
                  {state.data.points.map((point, index) => (
                    <li key={index} dir="rtl">
                      {point}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-mist">
                <span>
                  נכתב על ידי <bdi>{state.data.model}</bdi>, {formatRelative(state.data.generatedAt)}
                </span>
                <button type="button" onClick={onRefresh} className="inline-flex items-center gap-1 font-medium text-graphite hover:text-ink">
                  <RefreshCw size={12} aria-hidden="true" />
                  הסבר מחדש
                </button>
              </p>
            </>
          )}
        </div>
        <IconButton label="סגירת ההסבר" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>
    </section>
  );
}

/** The explanation's progress line. A long wait usually means the model is busy and the server is retrying. */
function ExplainProgress() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <p className="mt-2 text-[13.5px] text-graphite" role="status">
      {slow ? 'זה לוקח יותר מהרגיל. אם מודל ה-AI עמוס, השרת מנסה שוב אוטומטית…' : 'ניתוח הקובץ בעזרת AI…'}
    </p>
  );
}
