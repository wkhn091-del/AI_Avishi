import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button.jsx';
import { Modal } from '../../components/ui/Modal.jsx';
import { quote } from '../../lib/format.js';

/** Renames a conversation. The field opens with the current name selected; Enter saves. */
export function RenameDialog({ open, conversation, onClose, onSave }) {
  const [value, setValue] = useState('');
  const [state, setState] = useState({ busy: false, error: null });
  const field = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setValue(conversation?.title ?? '');
    setState({ busy: false, error: null });
    // The dialog focuses itself as it opens; then the field takes focus.
    const timer = setTimeout(() => {
      field.current?.focus();
      field.current?.select();
    }, 60);
    return () => clearTimeout(timer);
  }, [open, conversation]);

  const title = value.trim();
  const unchanged = title === (conversation?.title ?? '').trim();
  const submit = async (event) => {
    event.preventDefault();
    if (!title || unchanged || state.busy) return;
    setState({ busy: true, error: null });
    try {
      await onSave(conversation.id, title);
      onClose();
    } catch (error) {
      setState({ busy: false, error: error.message });
    }
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="rename-conversation-title" size="sm">
      <form onSubmit={submit} className="p-6">
        <h2 id="rename-conversation-title" className="text-[18px] font-semibold">
          שינוי שם השיחה
        </h2>
        <label className="mt-4 block">
          <span className="sr-only">שם השיחה</span>
          <input
            ref={field}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            maxLength={120}
            dir="auto"
            className="h-11 w-full rounded-xl border border-line-strong bg-surface px-3.5 text-[15px] outline-none focus:border-graphite"
          />
        </label>
        {state.error && (
          <p className="mt-2 text-[13px] text-danger" role="alert">
            {state.error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            ביטול
          </Button>
          <Button type="submit" variant="primary" disabled={!title || unchanged || state.busy}>
            שמירה
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Confirms deleting a conversation, which can't be undone. */
export function DeleteDialog({ open, conversation, onClose, onConfirm }) {
  const [state, setState] = useState({ busy: false, error: null });
  useEffect(() => {
    if (open) setState({ busy: false, error: null });
  }, [open]);

  const confirm = async () => {
    setState({ busy: true, error: null });
    try {
      await onConfirm(conversation.id);
      onClose();
    } catch (error) {
      setState({ busy: false, error: error.message });
    }
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="delete-conversation-title" size="sm">
      <div className="p-6">
        <h2 id="delete-conversation-title" className="text-[18px] font-semibold">
          למחוק את השיחה?
        </h2>
        <p className="mt-2 text-[14.5px] leading-relaxed text-graphite">
          השיחה <span className="font-medium text-ink">{quote(conversation?.title || 'שיחה חדשה')}</span> תימחק לצמיתות, יחד עם הקבצים המצורפים וקובצי ה-ZIP שנוצרו בה.
        </p>
        {state.error && (
          <p className="mt-2 text-[13px] text-danger" role="alert">
            {state.error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onClose}>ביטול</Button>
          <Button variant="danger" onClick={confirm} disabled={state.busy}>
            מחיקה
          </Button>
        </div>
      </div>
    </Modal>
  );
}
