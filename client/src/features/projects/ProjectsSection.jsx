import { AnimatePresence, motion } from 'framer-motion';
import { FileArchive } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { SectionHeader } from '../../components/layout/SectionHeader.jsx';
import { DropOverlay } from '../../components/ui/DropOverlay.jsx';
import { SearchField } from '../../components/ui/SearchField.jsx';
import { EmptyState, ErrorState, NoResults } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toaster.jsx';
import { useFileDrop } from '../../hooks/useFileDrop.js';
import { formatBytes, matchesQuery, pluralize } from '../../lib/format.js';
import { AddZipButton } from './AddZipButton.jsx';
import { Fingerprint } from './Fingerprint.jsx';
import { PendingProjectCard } from './PendingProjectCard.jsx';
import { ProjectCard } from './ProjectCard.jsx';
import { ProjectDetailsModal } from './details/ProjectDetailsModal.jsx';
import { kindOf } from './projectVisuals.js';

const gridItem = {
  layout: true,
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.97, transition: { duration: 0.16 } },
  transition: { type: 'spring', stiffness: 420, damping: 38 },
};

const EMPTY_ART = [
  ['other', 3], ['other', 5], ['docs', 2], ['other', 7], ['data', 4], ['other', 9], ['other', 6], ['asset', 3],
  ['other', 5], ['data', 2], ['other', 8], ['other', 4], ['docs', 3], ['other', 6], ['data', 2], ['other', 5],
];

/** Projects: ZIP archives analysed into cards. Drop .zip files anywhere on the page to add them. */
export function ProjectsSection({ state, query, onQueryChange, openId, onOpen, onClose }) {
  const toast = useToast();
  const isDragging = useFileDrop(state.addArchives);

  // A shared link (#projects/<id>) may point at a project that no longer exists.
  // Projects deleted from the dialog were seen first, so they close quietly.
  const seen = useRef(null);
  useEffect(() => {
    if (!openId || state.status !== 'ready') return;
    if (state.items.some((project) => project.id === openId)) seen.current = openId;
    else if (seen.current !== openId) {
      toast.error('הפרויקט לא נמצא. ייתכן שהוא נמחק.');
      onClose();
    }
  }, [openId, state.status, state.items, toast, onClose]);

  const visible = useMemo(
    () =>
      state.items.filter((project) =>
        matchesQuery(
          query,
          project.title,
          project.description,
          project.tags,
          project.techStack,
          kindOf(project.kind).label,
          project.archive?.originalName,
        ),
      ),
    [state.items, query],
  );

  // One flat list, so a finished upload keeps its grid slot (same key) and morphs in place.
  const cards = [
    ...(query ? [] : state.pending.map((item) => ({ key: item.tempId, pending: item }))),
    ...visible.map((project) => ({ key: project.clientKey ?? project.id, project })),
  ];

  const totalBytes = state.items.reduce((sum, project) => sum + (project.archive?.size ?? 0), 0);
  const meta = state.status === 'ready' && state.items.length ? [pluralize(state.items.length, 'פרויקט אחד', 'פרויקטים'), formatBytes(totalBytes)] : [];
  const openProject = state.items.find((project) => project.id === openId) ?? null;
  const isEmpty = state.status === 'ready' && state.items.length === 0 && state.pending.length === 0;

  return (
    <>
      <SectionHeader id="projects-title" title="פרויקטים" meta={meta}>
        <SearchField value={query} onChange={onQueryChange} label="חיפוש פרויקטים" />
        <AddZipButton onFiles={state.addArchives} busy={state.busy} />
      </SectionHeader>

      {state.status === 'error' && <ErrorState message={state.error} onRetry={() => state.reload()} />}

      {isEmpty && (
        <EmptyState
          art={<div className="w-40"><Fingerprint bars={EMPTY_ART} height={36} /></div>}
          title="הוסיפו את הפרויקט הראשון"
          action={<AddZipButton onFiles={state.addArchives} />}
          footnote="או גררו קובצי ZIP לכל מקום בעמוד"
        >
          Stash פותח את הארכיון, קורא את קובץ ה-README ואת קובצי התצורה, וכותב כותרת, תיאור קצר וסיכום של
          הטכנולוגיות. שום דבר לא מחולץ לדיסק, וקובץ ה-ZIP המקורי נשאר זמין להורדה.
        </EmptyState>
      )}

      {state.status === 'ready' && query && visible.length === 0 && <NoResults query={query} onClear={() => onQueryChange('')} />}

      {cards.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-4 sm:gap-5">
          <AnimatePresence mode="popLayout" initial={false}>
            {cards.map((card, index) => (
              <motion.li key={card.key} {...gridItem}>
                {card.pending ? (
                  <PendingProjectCard
                    item={card.pending}
                    onRetry={() => state.retry(card.pending.tempId)}
                    onDismiss={() => state.dismiss(card.pending.tempId)}
                  />
                ) : (
                  <ProjectCard project={card.project} index={index} onOpen={() => onOpen(card.project.id)} />
                )}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <ProjectDetailsModal project={openProject} onClose={onClose} actions={state} />
      <DropOverlay
        visible={isDragging}
        icon={FileArchive}
        title="שחררו כדי להוסיף פרויקטים"
        hint="כל קובץ ZIP ייקרא ויסוכם. קבצים אחרים שייכים לאזור הקבצים."
      />
    </>
  );
}
