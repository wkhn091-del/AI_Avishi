import { AudioLines, Clapperboard, Download, ExternalLink, Image as ImageIcon, Mic, Music, RotateCcw, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SectionHeader } from '../../components/layout/SectionHeader.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { ConfirmButton } from '../../components/ui/ConfirmButton.jsx';
import { EmptyState, ErrorState } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toaster.jsx';
import { cx } from '../../lib/cx.js';
import { formatBytes, formatRelative, pluralize } from '../../lib/format.js';
import { ListeningBars } from '../projects/Fingerprint.jsx';
import { Loading, TechnicalDetail } from '../projects/details/parts.jsx';
import { resourceUrl } from '../../lib/api.js';

export const MEDIA_TABS = [
  { id: 'image', label: 'תמונות', icon: ImageIcon },
  { id: 'audio', label: 'אודיו ומוזיקה', icon: AudioLines },
  { id: 'video', label: 'וידאו', icon: Clapperboard },
];
const KIND_LABELS = { image: 'תמונה', speech: 'הקראה', music: 'מוזיקה', video: 'וידאו' };
const PROMPTS = {
  image: { label: 'תיאור התמונה', placeholder: 'למשל: מגדלור על צוק בשקיעה, איור בצבעי מים' },
  speech: { label: 'טקסט להקראה', placeholder: 'הטקסט שיוקרא בקול' },
  music: { label: 'תיאור המוזיקה', placeholder: 'למשל: מנגינת פסנתר רגועה בקצב איטי' },
  video: { label: 'תיאור הסרטון', placeholder: 'למשל: גלים מתנפצים על חוף סלעי בשקיעה, תנועת מצלמה איטית' },
};
const COSTS = {
  image: 'מודלים זולים כמו Flux Schnell צורכים מעט מאוד Pollen, כך שהמענק היומי החינמי מספיק להרבה תמונות. מודלים שמסומנים "בתשלום" יקרים יותר.',
  speech: 'הקראה צורכת Pollen לפי אורך הטקסט. טקסטים קצרים זולים.',
  music: 'מוזיקה צורכת הרבה יותר Pollen מתמונות, וייתכן שהמענק היומי החינמי לא יספיק ליצירה אחת.',
  video: 'וידאו הוא הסוג היקר ביותר, וייתכן שהמענק היומי החינמי לא יספיק לסרטון אחד. יצירה יכולה להימשך כמה דקות.',
};
const fileUrl = (item, { download = false } = {}) => resourceUrl(`/api/media/${item.id}/file${download ? '?download=1' : ''}`);

function useElapsed(started) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!started) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [started]);
  if (!started) return null;
  const total = Math.max(0, Math.floor((now - started) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function Choice({ options, value, onChange, label }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cx(
            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium transition-colors',
            value === option.id ? 'border-ink bg-ink text-paper' : 'border-line text-graphite hover:border-line-strong hover:text-ink',
          )}
        >
          {option.shape}
          {option.label}
        </button>
      ))}
    </div>
  );
}

const shapeOf = (ratio) => {
  const [w, h] = ratio.split(':').map(Number);
  const scale = 14 / Math.max(w, h);
  return <span className="inline-block rounded-[2px] border border-current" style={{ width: w * scale, height: h * scale }} aria-hidden="true" />;
};

function Field({ label, htmlFor, children }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="text-[13px] font-medium">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

const selectClass = 'h-10 w-full rounded-full border border-line-strong bg-surface ps-3 pe-2 text-[14px]';

function MediaForm({ tab, media, reuse, onCreated }) {
  const data = media.options.data;
  const [mode, setMode] = useState('speech');
  const kind = tab === 'audio' ? mode : tab;
  const [prompts, setPrompts] = useState({});
  const [models, setModels] = useState({});
  const [aspects, setAspects] = useState({ image: data.aspects.image[0], video: data.aspects.video[0] });
  const [seed, setSeed] = useState('');
  const [safe, setSafe] = useState(true);
  const [voice, setVoice] = useState('nova');
  const [duration, setDuration] = useState(5);
  const [withAudio, setWithAudio] = useState(false);
  const [error, setError] = useState(null);
  const job = media.jobs[tab];
  const elapsed = useElapsed(job?.started);
  const model = models[kind] ?? data.defaults[kind];
  const prompt = prompts[kind] ?? '';

  // "Use this prompt" from a result.
  useEffect(() => {
    if (!reuse) return;
    if (tab === 'audio') setMode(reuse.kind);
    setPrompts((current) => ({ ...current, [reuse.kind]: reuse.prompt }));
    setModels((current) => ({ ...current, [reuse.kind]: reuse.model }));
    if (reuse.options?.aspect) setAspects((current) => ({ ...current, [reuse.kind]: reuse.options.aspect }));
    if (reuse.options?.voice) setVoice(reuse.options.voice);
    if (reuse.options?.duration) setDuration(reuse.options.duration);
  }, [reuse, tab]);

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      const item = await media.generate(tab, {
        kind,
        prompt,
        model,
        aspect: aspects[kind],
        seed: seed === '' ? undefined : Number(seed),
        safe,
        voice,
        duration,
        audio: withAudio,
      });
      onCreated(item);
    } catch (failure) {
      setError({ message: failure.message, detail: failure.details?.detail ?? null });
    }
  };

  const modelOptions = data.models[kind] ?? [];
  return (
    <form onSubmit={submit} className="space-y-5 rounded-[18px] border border-line bg-surface p-5 sm:p-6" noValidate>
      {tab === 'audio' && (
        <Choice
          label="סוג האודיו"
          value={mode}
          onChange={setMode}
          options={[
            { id: 'speech', label: 'הקראה', shape: <Mic size={13} aria-hidden="true" /> },
            { id: 'music', label: 'מוזיקה', shape: <Music size={13} aria-hidden="true" /> },
          ]}
        />
      )}
      <Field label={PROMPTS[kind].label} htmlFor="media-prompt">
        <textarea
          id="media-prompt"
          dir="auto"
          rows={kind === 'speech' ? 5 : 4}
          value={prompt}
          onChange={(event) => setPrompts((current) => ({ ...current, [kind]: event.target.value }))}
          placeholder={PROMPTS[kind].placeholder}
          className="w-full resize-y rounded-2xl border border-line-strong bg-surface px-4 py-3 text-[15px] leading-relaxed placeholder:text-mist focus:border-graphite"
        />
      </Field>
      <Field label="מודל" htmlFor="media-model">
        <select id="media-model" value={model} onChange={(event) => setModels((current) => ({ ...current, [kind]: event.target.value }))} className={selectClass}>
          {modelOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.paid ? `${option.id} (בתשלום)` : option.id}
            </option>
          ))}
        </select>
      </Field>
      {(kind === 'image' || kind === 'video') && (
        <Field label="יחס רוחב-גובה">
          <Choice
            label="יחס רוחב-גובה"
            value={aspects[kind]}
            onChange={(value) => setAspects((current) => ({ ...current, [kind]: value }))}
            options={data.aspects[kind].map((ratio) => ({ id: ratio, label: <bdi dir="ltr">{ratio}</bdi>, shape: shapeOf(ratio) }))}
          />
        </Field>
      )}
      {kind === 'speech' && (
        <Field label="קול" htmlFor="media-voice">
          <select id="media-voice" value={voice} onChange={(event) => setVoice(event.target.value)} className={selectClass}>
            {data.voices.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {kind === 'video' && (
        <div className="grid grid-cols-2 gap-4">
          <Field label="אורך" htmlFor="media-duration">
            <select id="media-duration" value={duration} onChange={(event) => setDuration(Number(event.target.value))} className={selectClass}>
              {data.videoDurations.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds} שניות
                </option>
              ))}
            </select>
          </Field>
          <label className="mt-6 flex items-center gap-2 text-[14px]">
            <input type="checkbox" checked={withAudio} onChange={(event) => setWithAudio(event.target.checked)} className="size-4 accent-ink" />
            עם פסקול
          </label>
        </div>
      )}
      {kind === 'image' && (
        <Field label="Seed (לא חובה)" htmlFor="media-seed">
          <input
            id="media-seed"
            inputMode="numeric"
            dir="ltr"
            value={seed}
            onChange={(event) => setSeed(event.target.value.replace(/\D/g, '').slice(0, 10))}
            placeholder="אקראי"
            className="h-10 w-40 rounded-full border border-line-strong bg-surface px-4 text-left font-mono text-[14px] placeholder:text-mist"
          />
        </Field>
      )}
      {(kind === 'image' || kind === 'video') && (
        <label className="flex items-center gap-2 text-[14px]">
          <input type="checkbox" checked={safe} onChange={(event) => setSafe(event.target.checked)} className="size-4 accent-ink" />
          סינון תוכן בוטה או אלים
        </label>
      )}
      <div>
        <Button type="submit" variant="primary" icon={Sparkles} disabled={Boolean(job) || !prompt.trim()} className="w-full justify-center">
          {job ? `יוצר… ${elapsed ?? ''}` : 'יצירה'}
        </Button>
        <p className="mt-2 text-[12.5px] leading-relaxed text-mist">{COSTS[kind]}</p>
      </div>
      {error && (
        <div className="rounded-xl border border-line bg-sunken/60 px-4 py-3" role="alert">
          <p className="bidi-plain text-[14px] leading-relaxed text-danger" dir="auto">
            {error.message}
          </p>
          {error.detail && <TechnicalDetail className="mt-1.5">{error.detail}</TechnicalDetail>}
        </div>
      )}
    </form>
  );
}

function Preview({ item, media, onReuse }) {
  const toast = useToast();
  const url = fileUrl(item);
  const facts = [
    KIND_LABELS[item.kind],
    item.options?.aspect,
    item.options?.duration ? `${item.options.duration} שניות` : null,
    item.options?.voice,
    formatBytes(item.size),
  ].filter(Boolean);
  const remove = async () => {
    try {
      await media.remove(item.id);
      toast.success('הקובץ נמחק');
    } catch (error) {
      toast.error(error.message);
    }
  };
  return (
    <figure className="overflow-hidden rounded-[18px] border border-line bg-surface">
      {item.kind === 'image' && <img src={url} alt={item.prompt} className="max-h-[68vh] w-full bg-sunken object-contain" />}
      {item.kind === 'video' && <video src={url} controls playsInline className="max-h-[68vh] w-full bg-black" />}
      {(item.kind === 'speech' || item.kind === 'music') && (
        <div className="flex items-center gap-4 bg-sunken/60 px-5 py-6">
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-surface text-ink">
            {item.kind === 'music' ? <Music size={20} aria-hidden="true" /> : <Mic size={20} aria-hidden="true" />}
          </span>
          <audio src={url} controls className="min-w-0 flex-1" />
        </div>
      )}
      <figcaption className="px-5 py-4">
        <p className="text-[15px] leading-relaxed" dir="auto">
          {item.prompt}
        </p>
        <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-mist">
          <bdi dir="ltr">{item.model}</bdi>
          {facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
          <time dateTime={item.createdAt}>{formatRelative(item.createdAt)}</time>
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button as="a" href={fileUrl(item, { download: true })} download size="sm" icon={Download}>
            הורדה
          </Button>
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => onReuse(item)}>
            שימוש בתיאור
          </Button>
          <span className="flex-1" />
          <ConfirmButton label="מחיקה" confirmLabel="למחוק את הקובץ?" onConfirm={remove} />
        </div>
      </figcaption>
    </figure>
  );
}

function Gallery({ items, selectedId, onSelect }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-3" aria-label="יצירות קודמות">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            onClick={() => onSelect(item.id)}
            aria-pressed={item.id === selectedId}
            className={cx('w-full overflow-hidden rounded-xl border text-start transition-colors', item.id === selectedId ? 'border-ink' : 'border-line hover:border-line-strong')}
          >
            {item.kind === 'image' && <img src={fileUrl(item)} alt="" loading="lazy" className="aspect-square w-full bg-sunken object-cover" />}
            {item.kind === 'video' && <video src={fileUrl(item)} preload="metadata" muted className="aspect-square w-full bg-black object-cover" />}
            {(item.kind === 'speech' || item.kind === 'music') && (
              <span className="grid aspect-square place-items-center bg-sunken text-graphite">
                {item.kind === 'music' ? <Music size={22} aria-hidden="true" /> : <Mic size={22} aria-hidden="true" />}
              </span>
            )}
            <span className="block truncate px-2 py-1.5 text-[12px] text-graphite" dir="auto">
              {item.prompt}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Working({ job, tab }) {
  const elapsed = useElapsed(job.started);
  return (
    <div className="rounded-[18px] border border-line bg-surface px-5 py-6" role="status">
      <ListeningBars active height={36} count={48} />
      <p className="mt-4 text-[15px] font-medium">יוצר {KIND_LABELS[job.kind]}… {elapsed}</p>
      <p className="mt-1 text-[13px] text-graphite">
        {tab === 'video' ? 'סרטונים יכולים להימשך כמה דקות. אפשר לעבור ללשונית אחרת בינתיים.' : 'אפשר לעבור ללשונית אחרת בינתיים.'}
      </p>
    </div>
  );
}

/** The media studio: images, speech and music, and video, generated with Pollinations. */
export function MediaSection({ media, tab, onTabChange }) {
  const { options, items, jobs } = media;
  const [selected, setSelected] = useState({});
  const [reuse, setReuse] = useState(null);
  const current = MEDIA_TABS.some((item) => item.id === tab) ? tab : 'image';
  const kinds = current === 'audio' ? ['speech', 'music'] : [current];
  const list = items.list.filter((item) => kinds.includes(item.kind));
  const shown = list.find((item) => item.id === selected[current]) ?? list[0] ?? null;
  const meta = items.status === 'ready' && items.list.length ? [pluralize(items.list.length, 'יצירה אחת', 'יצירות')] : [];

  let content;
  if (options.status === 'loading') content = <Loading label="טוען את הסטודיו…" />;
  else if (options.status === 'error') content = <ErrorState message={options.error} onRetry={media.reload} />;
  else if (!options.data.configured) {
    content = (
      <EmptyState
        art={<Sparkles size={30} strokeWidth={1.6} className="text-graphite" aria-hidden="true" />}
        title="חברו את Pollinations"
        action={
          <Button as="a" href="https://enter.pollinations.ai/keys" target="_blank" rel="noopener noreferrer" variant="primary" icon={ExternalLink}>
            יצירת מפתח חינמי
          </Button>
        }
        footnote="והוסיפו אותו כ-POLLINATIONS_API_KEY בקובץ server/.env"
      >
        הסטודיו יוצר תמונות, הקראות, מוזיקה וסרטונים דרך Pollinations. ההרשמה חינמית ובלי כרטיס אשראי, והחשבון מקבל מענק Pollen יומי: מספיק להרבה תמונות, פחות למוזיקה ולווידאו.
      </EmptyState>
    );
  } else {
    content = (
      <>
        <div className="mb-5 flex rounded-full bg-sunken p-1 sm:inline-flex" role="tablist" aria-label="סוג המדיה">
          {MEDIA_TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={id === current}
              onClick={() => onTabChange(id)}
              className={cx(
                'inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-full px-2.5 py-1.5 text-[14px] font-medium transition-colors sm:flex-none sm:px-4',
                id === current ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(13_16_22/0.14)]' : 'text-graphite hover:text-ink',
              )}
            >
              <Icon size={15} className="hidden sm:inline" aria-hidden="true" />
              {label}
              {jobs[id] && <span className="size-1.5 animate-pulse rounded-full bg-ok" aria-label="ביצירה" />}
            </button>
          ))}
        </div>
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
          <MediaForm key={current} tab={current} media={media} reuse={reuse} onCreated={(item) => setSelected((state) => ({ ...state, [current]: item.id }))} />
          <div className="min-w-0 space-y-5">
            {jobs[current] && <Working job={jobs[current]} tab={current} />}
            {shown ? (
              <Preview item={shown} media={media} onReuse={setReuse} />
            ) : (
              !jobs[current] && (
                <div className="grid min-h-64 place-items-center rounded-[18px] border border-dashed border-line-strong px-6 text-center text-[14.5px] text-graphite">
                  מה שתיצרו יופיע כאן, יחד עם כפתור הורדה.
                </div>
              )
            )}
            {list.length > 1 && <Gallery items={list} selectedId={shown?.id} onSelect={(id) => setSelected((state) => ({ ...state, [current]: id }))} />}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <SectionHeader id="media-title" title="סטודיו מדיה" meta={meta} />
      {content}
    </>
  );
}
