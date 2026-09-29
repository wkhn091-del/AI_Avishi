import { Link2, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '../../components/ui/Button.jsx';

/**
 * The paste bar. The field clears as soon as a link is submitted (the grid
 * shows its progress), so several links can be pasted in a row. A link the
 * server rejects as invalid is put back so it can be corrected. The field is
 * right-to-left while empty (Hebrew placeholder) and left-to-right once a URL
 * is typed; symmetric padding keeps the text clear of the icon either way.
 */
export function AddLinkForm({ onSave }) {
  const [value, setValue] = useState('');
  const input = useRef(null);

  const submit = async (event) => {
    event.preventDefault();
    const url = value.trim();
    if (!url) return input.current?.focus();
    setValue('');
    const result = await onSave(url);
    if (result.invalid) setValue((current) => current || url);
  };

  return (
    <form onSubmit={submit} noValidate className="mb-8 flex flex-col gap-3 sm:flex-row">
      <div className="relative flex-1">
        <Link2 size={18} className="pointer-events-none absolute top-1/2 start-4 -translate-y-1/2 text-mist" aria-hidden="true" />
        <input
          ref={input}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="הדביקו קישור, למשל github.com/owner/repo"
          aria-label="קישור לשמירה"
          dir={value.trim() ? 'ltr' : 'rtl'}
          className="h-12 w-full rounded-full border border-line-strong bg-surface px-11 text-[15.5px] placeholder:text-mist focus:border-graphite"
        />
      </div>
      <Button type="submit" variant="primary" icon={Plus} className="h-12 px-6">
        שמירת קישור
      </Button>
    </form>
  );
}
