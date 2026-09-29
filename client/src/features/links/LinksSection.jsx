import { AnimatePresence, motion } from 'framer-motion';
import { Link2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionHeader } from '../../components/layout/SectionHeader.jsx';
import { SearchField } from '../../components/ui/SearchField.jsx';
import { EmptyState, ErrorState, NoResults } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toaster.jsx';
import { copyText } from '../../lib/clipboard.js';
import { matchesQuery, pluralize } from '../../lib/format.js';
import { AddLinkForm } from './AddLinkForm.jsx';
import { LinkCard, SavingLinkCard } from './LinkCard.jsx';

const gridItem = {
  layout: true,
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.97, transition: { duration: 0.16 } },
  transition: { type: 'spring', stiffness: 420, damping: 38 },
};

const looksLikeUrl = (text) => /^(https?:\/\/)?[^\s/]+\.[a-z\u00a1-\uffff]{2,}(:\d+)?([/?#]\S*)?$/i.test(text);
const isTyping = (element) =>
  element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable);

/** Links: paste a URL, get a card with its title, description and preview image. */
export function LinksSection({ state, query, onQueryChange }) {
  const toast = useToast();
  const [highlight, setHighlight] = useState(null);
  const { add } = state;

  const save = useCallback(
    async (url) => {
      const result = await add(url);
      if (result.duplicateId) setHighlight({ id: result.duplicateId, key: Date.now() });
      return result;
    },
    [add],
  );

  // Paste a link anywhere on this page (outside a text field) to save it.
  useEffect(() => {
    const onPaste = (event) => {
      if (isTyping(document.activeElement)) return;
      const text = event.clipboardData?.getData('text/plain')?.trim();
      if (!text || !looksLikeUrl(text)) return;
      event.preventDefault();
      save(text);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [save]);

  const visible = useMemo(
    () => state.items.filter((link) => matchesQuery(query, link.title, link.description, link.url, link.domain, link.siteName)),
    [state.items, query],
  );
  const cards = [
    ...(query ? [] : state.saving.map((item) => ({ key: item.tempId, saving: item }))),
    ...visible.map((link) => ({ key: link.clientKey ?? link.id, link })),
  ];

  const actions = {
    onCopy: async (url) => {
      try {
        await copyText(url);
        return true;
      } catch {
        toast.error('ההעתקה נכשלה: הדפדפן חסם את הגישה ללוח.');
        return false;
      }
    },
    onRefresh: async (id) => {
      try {
        const link = await state.refresh(id);
        if (link.metadataStatus === 'ok') toast.success('התצוגה המקדימה עודכנה');
        else toast.info(`התצוגה המקדימה עדיין לא זמינה. ${link.metadataNote ?? ''}`.trim());
      } catch (error) {
        toast.error(error.message);
      }
    },
    onDelete: async (id) => {
      try {
        await state.remove(id);
        toast.success('הקישור נמחק');
      } catch (error) {
        toast.error(error.message);
      }
    },
  };

  const isEmpty = state.status === 'ready' && state.items.length === 0 && state.saving.length === 0;

  return (
    <>
      <SectionHeader
        id="links-title"
        title="קישורים"
        meta={state.status === 'ready' && state.items.length ? [pluralize(state.items.length, 'קישור אחד', 'קישורים')] : []}
      >
        <SearchField value={query} onChange={onQueryChange} label="חיפוש קישורים" />
      </SectionHeader>

      <AddLinkForm onSave={save} />

      {state.status === 'error' && <ErrorState message={state.error} onRetry={() => state.reload()} />}

      {isEmpty && (
        <EmptyState
          art={<Link2 size={30} strokeWidth={1.6} className="text-graphite" aria-hidden="true" />}
          title="שמרו את הקישור הראשון"
        >
          הדביקו כתובת אינטרנט בשורה שלמעלה. Stash שולף את הכותרת, התיאור ותמונת התצוגה המקדימה של הדף, כך שקל
          לזהות את הכרטיס אחר כך. אפשר גם להדביק קישור בכל מקום בעמוד.
        </EmptyState>
      )}

      {state.status === 'ready' && query && visible.length === 0 && <NoResults query={query} onClear={() => onQueryChange('')} />}

      {cards.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 sm:gap-5">
          <AnimatePresence mode="popLayout" initial={false}>
            {cards.map((card) => (
              <motion.li key={card.key} {...gridItem}>
                {card.saving ? (
                  <SavingLinkCard url={card.saving.url} />
                ) : (
                  <LinkCard link={card.link} highlightKey={highlight?.id === card.link.id ? highlight.key : null} {...actions} />
                )}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </>
  );
}
