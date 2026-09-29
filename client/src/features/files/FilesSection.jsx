import { AnimatePresence, motion } from 'framer-motion';
import { FolderUp, LayoutGrid, List, Upload } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { SectionHeader } from '../../components/layout/SectionHeader.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { DropOverlay } from '../../components/ui/DropOverlay.jsx';
import { SearchField } from '../../components/ui/SearchField.jsx';
import { EmptyState, ErrorState, NoResults } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toaster.jsx';
import { useFileDrop } from '../../hooks/useFileDrop.js';
import { cx } from '../../lib/cx.js';
import { formatBytes, matchesQuery, pluralize, quote } from '../../lib/format.js';
import { FileRow, FileTile, LIST_COLUMNS, UploadRow, UploadTile } from './FileItem.jsx';
import { fileTypeOf } from './fileTypes.js';

const VIEW_KEY = 'stash:files-view';
const readView = () => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
};

const itemMotion = {
  layout: true,
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.97, transition: { duration: 0.16 } },
  transition: { type: 'spring', stiffness: 420, damping: 38 },
};
const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.15 } };

/** Files: general storage with image thumbnails, grid or list. Drop files anywhere on the page to upload. */
export function FilesSection({ state, query, onQueryChange }) {
  const toast = useToast();
  const [view, setView] = useState(readView);
  const picker = useRef(null);
  const isDragging = useFileDrop(state.add);

  const changeView = (next) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // storage unavailable (private mode) — the choice just won't persist
    }
  };

  const remove = async (file) => {
    try {
      await state.remove(file.id);
      toast.success(`הקובץ ${quote(file.originalName)} נמחק`);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const visible = useMemo(
    () => state.items.filter((file) => matchesQuery(query, file.originalName, fileTypeOf(file.extension).label)),
    [state.items, query],
  );
  const items = [
    ...(query ? [] : state.uploads.map((upload) => ({ key: upload.tempId, upload }))),
    ...visible.map((file) => ({ key: file.clientKey ?? file.id, file })),
  ];

  const totalBytes = state.items.reduce((sum, file) => sum + file.size, 0);
  const meta = state.status === 'ready' && state.items.length ? [pluralize(state.items.length, 'קובץ אחד', 'קבצים'), formatBytes(totalBytes)] : [];
  const isEmpty = state.status === 'ready' && state.items.length === 0 && state.uploads.length === 0;
  const openPicker = () => picker.current?.click();

  return (
    <>
      <SectionHeader id="files-title" title="קבצים" meta={meta}>
        <SearchField value={query} onChange={onQueryChange} label="חיפוש קבצים" />
        <ViewToggle view={view} onChange={changeView} />
        <Button variant="primary" icon={Upload} onClick={openPicker}>
          העלאת קבצים
        </Button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (files.length) state.add(files);
          }}
        />
      </SectionHeader>

      {state.status === 'error' && <ErrorState message={state.error} onRetry={() => state.reload()} />}

      {isEmpty && (
        <EmptyState
          art={<FolderUp size={30} strokeWidth={1.6} className="text-graphite" aria-hidden="true" />}
          title="העלו את הקבצים הראשונים"
          action={
            <Button variant="primary" icon={Upload} onClick={openPicker}>
              העלאת קבצים
            </Button>
          }
          footnote="או גררו קבצים לכל מקום בעמוד"
        >
          שמרו כאן מסמכים, תמונות, קובצי התקנה וכל דבר אחר. תמונות מקבלות תמונה ממוזערת, וכל קובץ יורד עם השם
          המקורי שלו.
        </EmptyState>
      )}

      {state.status === 'ready' && query && visible.length === 0 && <NoResults query={query} onClear={() => onQueryChange('')} />}

      {items.length > 0 && (
        <AnimatePresence mode="wait" initial={false}>
          {view === 'grid' ? (
            <motion.ul key="grid" {...fade} className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3 sm:gap-4">
              <AnimatePresence mode="popLayout" initial={false}>
                {items.map((item) => (
                  <motion.li key={item.key} {...itemMotion}>
                    {item.upload ? <UploadTile upload={item.upload} /> : <FileTile file={item.file} onDelete={remove} />}
                  </motion.li>
                ))}
              </AnimatePresence>
            </motion.ul>
          ) : (
            <motion.div key="list" {...fade} className="overflow-hidden rounded-[14px] border border-line bg-surface">
              <div
                aria-hidden="true"
                className={cx('hidden gap-4 border-b border-line px-4 py-2.5 text-[13px] text-graphite sm:grid', LIST_COLUMNS)}
              >
                <span />
                <span>שם</span>
                <span>סוג</span>
                <span className="text-end">גודל</span>
                <span className="text-end">נוסף</span>
                <span className="w-[66px]" />
              </div>
              <ul className="divide-y divide-line">
                <AnimatePresence mode="popLayout" initial={false}>
                  {items.map((item) => (
                    <motion.li key={item.key} layout {...fade}>
                      {item.upload ? <UploadRow upload={item.upload} /> : <FileRow file={item.file} onDelete={remove} />}
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
      )}

      <DropOverlay visible={isDragging} icon={Upload} title="שחררו כדי להעלות" hint="כל סוג קובץ, עד 20 בכל פעם." />
    </>
  );
}

function ViewToggle({ view, onChange }) {
  const options = [
    { id: 'grid', label: 'רשת', icon: LayoutGrid },
    { id: 'list', label: 'רשימה', icon: List },
  ];
  return (
    <div role="radiogroup" aria-label="תצוגה" className="flex shrink-0 rounded-full bg-sunken p-1">
      {options.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={view === id}
          aria-label={label}
          title={label}
          onClick={() => onChange(id)}
          className={cx('relative inline-flex h-8 w-10 items-center justify-center rounded-full transition-colors', view === id ? 'text-ink' : 'text-graphite hover:text-ink')}
        >
          {view === id && (
            <motion.span
              layoutId="files-view-highlight"
              className="absolute inset-0 rounded-full bg-surface shadow-[0_1px_2px_rgb(13_16_22/0.14)]"
              transition={{ type: 'spring', stiffness: 500, damping: 38 }}
            />
          )}
          <Icon size={16} className="relative" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
