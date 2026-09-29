import { X } from 'lucide-react';
import { useId, useState } from 'react';

const inputClass =
  'w-full rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-[15px] placeholder:text-mist focus:border-graphite';

/**
 * Title, description and tags. The draft lives in the dialog, so it survives
 * while the form re-renders; the footer's save button submits it by form id.
 */
export function EditForm({ draft, setDraft, error, onSubmit }) {
  const ids = useId();
  const change = (field) => (event) => setDraft((current) => ({ ...current, [field]: event.target.value }));
  return (
    <form id="project-edit-form" onSubmit={onSubmit} noValidate className="mt-5 space-y-5">
      <Field id={`${ids}-title`} label="כותרת" count={`${draft.title.length}/120`}>
        <input
          id={`${ids}-title`}
          autoFocus
          value={draft.title}
          maxLength={120}
          onChange={change('title')}
          dir="auto"
          className={`${inputClass} font-semi-wide text-[18px] font-semibold`}
        />
      </Field>
      <Field id={`${ids}-description`} label="תיאור" count={`${draft.description.length}/600`}>
        <textarea
          id={`${ids}-description`}
          rows={4}
          value={draft.description}
          maxLength={600}
          onChange={change('description')}
          dir="auto"
          className={`${inputClass} resize-y leading-relaxed`}
        />
      </Field>
      <Field id={`${ids}-tags`} label="תגיות" count={`${draft.tags.length}/12`}>
        <TagEditor id={`${ids}-tags`} tags={draft.tags} onChange={(tags) => setDraft((current) => ({ ...current, tags }))} />
      </Field>
      {error && (
        <p role="alert" className="bidi-plain text-[14px] text-danger" dir="auto">
          {error}
        </p>
      )}
    </form>
  );
}

function Field({ id, label, count, children }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-[13px]">
        <label htmlFor={id} className="font-medium text-graphite">
          {label}
        </label>
        <span className="font-narrow text-mist">{count}</span>
      </div>
      {children}
    </div>
  );
}

/** Chips plus a text box: Enter or comma adds a tag, Backspace in an empty box removes the last one. */
function TagEditor({ id, tags, onChange }) {
  const [text, setText] = useState('');
  const add = (raw) => {
    const tag = raw.replace(/\s+/g, ' ').trim();
    setText('');
    if (!tag || tag.length > 30 || tags.length >= 12 || tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
    onChange([...tags, tag]);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-line-strong bg-surface p-2 focus-within:border-graphite">
      {tags.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-sunken py-0.5 ps-2.5 pe-1 text-[13.5px]" dir="auto">
          {tag}
          <button
            type="button"
            onClick={() => onChange(tags.filter((t) => t !== tag))}
            aria-label={`הסרת ${tag}`}
            className="inline-flex size-5 items-center justify-center rounded text-mist hover:bg-line hover:text-ink"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        maxLength={31}
        placeholder={tags.length ? 'הוספת תגית' : 'הוספת תגיות, למשל React, משחק'}
        dir="auto"
        onChange={(event) => {
          const value = event.target.value;
          if (value.endsWith(',')) add(value.slice(0, -1));
          else setText(value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            add(text);
          } else if (event.key === 'Backspace' && !text && tags.length) {
            onChange(tags.slice(0, -1));
          }
        }}
        onBlur={() => text && add(text)}
        className="min-w-32 flex-1 bg-transparent px-1.5 py-1 text-[14.5px] outline-none placeholder:text-mist"
      />
    </div>
  );
}
