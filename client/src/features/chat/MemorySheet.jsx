/**
 * The long-term memory, for the person to see and control: what Stash learned
 * about how they work (or what they added themselves), grouped by kind, with
 * adding, editing and forgetting.
 */
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { BottomSheet } from '../../components/ui/BottomSheet.jsx';
import { Button, IconButton } from '../../components/ui/Button.jsx';
import { ConfirmButton } from '../../components/ui/ConfirmButton.jsx';
import { useToast } from '../../components/ui/Toaster.jsx';
import { request } from '../../lib/api.js';

const KINDS = [
  { id: 'preference', title: 'העדפות', one: 'העדפה' },
  { id: 'style', title: 'סגנון קוד', one: 'סגנון קוד' },
  { id: 'rule', title: 'כללי פרויקטים', one: 'כלל של פרויקט' },
  { id: 'fact', title: 'עובדות', one: 'עובדה' },
];
const MAX = 300;
const FIELD = 'rounded-xl border border-line-strong bg-paper px-3 text-[14.5px] focus:border-graphite focus:outline-none';

function metaOf(memory) {
  return [
    memory.project && `פרויקט ${memory.project}`,
    memory.source === 'learned' ? (memory.confirmations > 1 ? `נלמד ${memory.confirmations} פעמים` : 'נלמד משיחה') : 'נוסף ידנית',
    memory.uses > 0 && (memory.uses === 1 ? 'שימש פעם אחת' : `שימש ${memory.uses} פעמים`),
  ]
    .filter(Boolean)
    .join(' · ');
}

export function MemorySheet({ open, onClose }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState({ content: '', kind: 'preference', project: '' });
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await request('/memory'));
      setError(null);
    } catch (problem) {
      setError(problem.message);
    }
  }, []);

  useEffect(() => {
    if (open) load();
    else setEditing(null);
  }, [open, load]);

  const run = async (action, done) => {
    setBusy(true);
    try {
      await action();
      await load();
      toast.success(done);
      return true;
    } catch (problem) {
      toast.error(problem.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const saved = await run(() => request('/memory', { method: 'POST', body: { content: draft.content, kind: draft.kind, project: draft.kind === 'rule' ? draft.project : '' } }), 'הזיכרון נשמר');
    if (saved) setDraft((current) => ({ ...current, content: '', project: '' }));
  };
  const save = async () => {
    if (await run(() => request(`/memory/${editing.id}`, { method: 'PATCH', body: { content: editing.content } }), 'הזיכרון עודכן')) setEditing(null);
  };
  const forget = (memory) => run(() => request(`/memory/${memory.id}`, { method: 'DELETE' }), 'הזיכרון נמחק');
  const clear = () => run(() => request('/memory', { method: 'DELETE' }), 'כל הזיכרון נמחק');

  const memories = data?.memories ?? [];
  return (
    <BottomSheet open={open} onClose={onClose} id="long-term-memory" title="זיכרון לטווח ארוך">
      <div className="space-y-5 px-6 pb-6">
        <p className="text-[14px] leading-relaxed text-graphite">
          מה שלמדתי על הדרך שבה אתם עובדים, משיחות קודמות או ממה שהוספתם כאן. כל מודל מקבל את מה שקשור לבקשה, ולא מזכיר את זה בתשובה.
        </p>
        {error && (
          <p role="alert" className="text-[14px] text-danger">
            {error}
          </p>
        )}
        {data && !data.enabled && <p className="rounded-xl bg-sunken px-4 py-3 text-[14px] text-graphite">הזיכרון לטווח ארוך כבוי בשרת (LONG_TERM_MEMORY=off).</p>}

        {data?.enabled && (
          <div className="space-y-2.5 rounded-2xl border border-line p-3.5">
            <label className="block text-[13px] font-medium text-graphite" htmlFor="memory-new">
              הוספת זיכרון
            </label>
            <textarea
              id="memory-new"
              value={draft.content}
              maxLength={MAX}
              rows={2}
              dir="auto"
              placeholder="למשל: תמיד TypeScript, עם ייצוא בשם ולא default"
              onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              className={`w-full resize-none py-2 ${FIELD}`}
            />
            <div className="flex flex-wrap items-center gap-2">
              <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })} aria-label="סוג הזיכרון" className={`h-9 !rounded-full text-[13.5px] ${FIELD}`}>
                {KINDS.map((kind) => (
                  <option key={kind.id} value={kind.id}>
                    {kind.one}
                  </option>
                ))}
              </select>
              {draft.kind === 'rule' && (
                <input
                  value={draft.project}
                  maxLength={100}
                  dir="auto"
                  placeholder="שם הפרויקט"
                  aria-label="שם הפרויקט"
                  onChange={(event) => setDraft({ ...draft, project: event.target.value })}
                  className={`h-9 min-w-0 flex-1 !rounded-full text-[13.5px] ${FIELD}`}
                />
              )}
              <Button size="sm" icon={Plus} className="ms-auto" disabled={busy || draft.content.trim().length < 3} onClick={add}>
                הוספה
              </Button>
            </div>
          </div>
        )}

        {data?.enabled && memories.length === 0 && <p className="text-[14px] text-mist">עדיין לא למדתי עליכם כלום. ספרו בשיחה איך אתם אוהבים לעבוד, או הוסיפו כאן.</p>}

        {KINDS.map((kind) => {
          const items = memories.filter((memory) => memory.kind === kind.id);
          if (!items.length) return null;
          return (
            <section key={kind.id} aria-labelledby={`memory-kind-${kind.id}`}>
              <h3 id={`memory-kind-${kind.id}`} className="mb-1.5 text-[12.5px] font-semibold text-mist">
                {kind.title} ({items.length})
              </h3>
              <ul className="divide-y divide-line rounded-2xl border border-line">
                {items.map((memory) => (
                  <li key={memory.id} className="flex items-start gap-1.5 px-3.5 py-2.5">
                    {editing?.id === memory.id ? (
                      <>
                        <textarea
                          autoFocus
                          value={editing.content}
                          maxLength={MAX}
                          rows={2}
                          dir="auto"
                          aria-label="עריכת הזיכרון"
                          onChange={(event) => setEditing({ ...editing, content: event.target.value })}
                          className={`min-w-0 flex-1 resize-none py-2 ${FIELD}`}
                        />
                        <IconButton label="שמירה" disabled={busy || editing.content.trim().length < 3} onClick={save}>
                          <Check size={15} aria-hidden="true" />
                        </IconButton>
                        <IconButton label="ביטול" onClick={() => setEditing(null)}>
                          <X size={15} aria-hidden="true" />
                        </IconButton>
                      </>
                    ) : (
                      <>
                        <div className="min-w-0 flex-1">
                          <p className="text-[14.5px] leading-snug text-ink" dir="auto">
                            {memory.content}
                          </p>
                          <p className="mt-0.5 text-[12px] text-mist">{metaOf(memory)}</p>
                        </div>
                        <IconButton label="עריכה" disabled={busy} onClick={() => setEditing({ id: memory.id, content: memory.content })}>
                          <Pencil size={15} aria-hidden="true" />
                        </IconButton>
                        <IconButton label="מחיקה" disabled={busy} onClick={() => forget(memory)}>
                          <Trash2 size={15} aria-hidden="true" />
                        </IconButton>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

        {memories.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-[12.5px] text-mist">
              נשמר ב-<bdi dir="ltr">{data.database}</bdi>
              {data.embeddings ? (
                <>
                  , חיפוש לפי משמעות עם <bdi dir="ltr">{data.embeddings}</bdi>
                </>
              ) : (
                ', חיפוש לפי מילים'
              )}
            </p>
            <ConfirmButton onConfirm={clear} label="מחיקת הכול" confirmLabel={`למחוק את כל ${memories.length}?`} disabled={busy} />
          </div>
        )}
      </div>
    </BottomSheet>
  );
}
