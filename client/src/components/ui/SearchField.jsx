import { Search, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

const isTyping = (element) =>
  element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable);

/** Search input. "/" focuses it from anywhere, Escape clears it. */
export function SearchField({ value, onChange, label }) {
  const input = useRef(null);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || isTyping(document.activeElement)) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="relative flex h-10 w-full items-center sm:w-64">
      <Search size={16} className="pointer-events-none absolute start-3.5 text-mist" aria-hidden="true" />
      <input
        ref={input}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.stopPropagation();
            onChange('');
          }
        }}
        placeholder={label}
        aria-label={label}
        dir="auto"
        className="h-full w-full rounded-full border border-line bg-surface px-10 text-[14.5px] placeholder:text-mist focus:border-line-strong"
      />
      {value ? (
        <button
          type="button"
          onClick={() => {
            onChange('');
            input.current?.focus();
          }}
          aria-label="ניקוי החיפוש"
          className="absolute end-2 inline-flex size-7 items-center justify-center rounded-full text-mist hover:bg-sunken hover:text-ink"
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : (
        <kbd className="pointer-events-none absolute end-3 hidden rounded-md border border-line px-1.5 font-narrow text-[12px] text-mist sm:block">
          /
        </kbd>
      )}
    </div>
  );
}
