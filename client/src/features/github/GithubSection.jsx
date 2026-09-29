import { AnimatePresence, motion } from 'framer-motion';
import { FolderGit2, RefreshCw, Settings } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { SectionHeader } from '../../components/layout/SectionHeader.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { SearchField } from '../../components/ui/SearchField.jsx';
import { EmptyState, ErrorState, NoResults } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toaster.jsx';
import { isolate, matchesQuery, pluralize } from '../../lib/format.js';
import { ProjectDetailsModal } from '../projects/details/ProjectDetailsModal.jsx';
import { kindOf } from '../projects/projectVisuals.js';
import { RepoCard } from './RepoCard.jsx';

const gridItem = {
  layout: true,
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.97, transition: { duration: 0.16 } },
  transition: { type: 'spring', stiffness: 420, damping: 38 },
};

/** GitHub: your repositories as cards; each opens the same workspace as a ZIP project. */
export function GithubSection({ github, query, onQueryChange, openId, onOpen, onClose, onOpenSettings }) {
  const toast = useToast();
  const { connection, repos, reposStatus, reposError, analyses, analyze } = github;
  const connected = Boolean(connection.data?.connected);

  const visible = useMemo(
    () =>
      repos.filter((repo) =>
        matchesQuery(query, repo.title, repo.description, repo.tags, repo.github.fullName, repo.github.language, repo.analyzed ? kindOf(repo.kind).label : ''),
      ),
    [repos, query],
  );
  const openRepo = repos.find((repo) => repo.id === openId) ?? null;

  // Opening a repository that hasn't been analysed yet starts its analysis.
  useEffect(() => {
    if (openRepo && !openRepo.analyzed && !analyses[openRepo.id]) analyze(openRepo.id).catch(() => {});
  }, [openRepo, analyses, analyze]);

  // A shared link (#github/owner/repo) may point at a repository that isn't in your list.
  const seen = useRef(null);
  useEffect(() => {
    if (!openId || reposStatus !== 'ready') return;
    if (openRepo) seen.current = openId;
    else if (seen.current !== openId) {
      toast.error('המאגר לא נמצא ברשימת המאגרים שלכם.');
      onClose();
    }
  }, [openId, reposStatus, openRepo, toast, onClose]);

  const meta =
    connected && reposStatus === 'ready' ? [pluralize(repos.length, 'מאגר אחד', 'מאגרים'), isolate(`@${connection.data.user.login}`)] : [];
  const details = openRepo ? { ...openRepo, analysisState: analyses[openRepo.id] ?? null } : null;
  const actions = { update: github.update, reanalyze: github.reanalyze, analyze };

  let content = null;
  if (connection.status === 'error') content = <ErrorState message={connection.error} onRetry={() => github.reload()} />;
  else if (connection.status === 'ready' && !connected) content = <NotConnected connection={connection.data} onOpenSettings={onOpenSettings} />;
  else if (reposStatus === 'error') content = <ErrorState message={reposError} onRetry={github.loadRepos} />;
  else if (reposStatus === 'ready' && repos.length === 0) {
    content = (
      <EmptyState art={<FolderGit2 size={30} strokeWidth={1.6} className="text-graphite" aria-hidden="true" />} title="אין מאגרים להצגה">
        לחשבון הזה עדיין אין מאגרים, או שלטוקן אין גישה אליהם. אפשר לבדוק את הרשאות הטוקן בהגדרות.
      </EmptyState>
    );
  } else if (reposStatus === 'ready' && query && visible.length === 0) {
    content = <NoResults query={query} onClear={() => onQueryChange('')} />;
  } else if (reposStatus === 'ready') {
    content = (
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-4 sm:gap-5">
        <AnimatePresence mode="popLayout" initial={false}>
          {visible.map((repo, index) => (
            <motion.li key={repo.id} {...gridItem}>
              <RepoCard repo={repo} index={index} analysis={analyses[repo.id]} onOpen={() => onOpen(repo.id)} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    );
  }

  return (
    <>
      <SectionHeader id="github-title" title="גיטהאב" meta={meta}>
        {connected && <SearchField value={query} onChange={onQueryChange} label="חיפוש מאגרים" />}
        {connected && (
          <Button icon={RefreshCw} onClick={() => github.loadRepos()} disabled={reposStatus === 'loading'}>
            רענון
          </Button>
        )}
      </SectionHeader>
      {content}
      <ProjectDetailsModal project={details} onClose={onClose} actions={actions} />
    </>
  );
}

function NotConnected({ connection, onOpenSettings }) {
  const failed = Boolean(connection?.error);
  return (
    <EmptyState
      art={<FolderGit2 size={30} strokeWidth={1.6} className="text-graphite" aria-hidden="true" />}
      title={failed ? 'החיבור ל-GitHub נכשל' : 'חברו את GitHub'}
      action={
        <Button variant="primary" icon={Settings} onClick={onOpenSettings}>
          {failed ? 'עדכון הטוקן' : 'חיבור בהגדרות'}
        </Button>
      }
      footnote={failed ? null : 'או הגדירו GITHUB_TOKEN בקובץ server/.env'}
    >
      {failed
        ? <span className="bidi-plain" dir="auto">{connection.error.message}</span>
        : 'הוסיפו טוקן גישה אישי כדי לראות כאן את המאגרים שלכם, עם אותם סיכומים בעברית, הסברי קבצים ותצוגה מקדימה כמו בפרויקטים.'}
    </EmptyState>
  );
}
