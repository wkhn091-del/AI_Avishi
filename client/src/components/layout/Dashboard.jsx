import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatSection } from '../../features/chat/ChatSection.jsx';
import { useChat } from '../../features/chat/useChat.js';
import { FilesSection } from '../../features/files/FilesSection.jsx';
import { GithubSection } from '../../features/github/GithubSection.jsx';
import { useGithub } from '../../features/github/useGithub.js';
import { useFiles } from '../../features/files/useFiles.js';
import { LinksSection } from '../../features/links/LinksSection.jsx';
import { MediaSection } from '../../features/media/MediaSection.jsx';
import { useMedia } from '../../features/media/useMedia.js';
import { useLinks } from '../../features/links/useLinks.js';
import { ProjectsSection } from '../../features/projects/ProjectsSection.jsx';
import { useProjects } from '../../features/projects/useProjects.js';
import { useHealth } from '../../hooks/useHealth.js';
import { useAuth } from '../../features/auth/AuthProvider.jsx';
import { cx } from '../../lib/cx.js';
import { SettingsModal } from '../settings/SettingsModal.jsx';
import { SECTIONS, TopBar } from './TopBar.jsx';

const ORDER = SECTIONS.map((section) => section.id);
/**
 * "#projects/<id>" and "#github/<owner>/<repo>" open an item's dialog; "#links"
 * and "#files" just pick the tab. Unknown hashes fall back to Projects.
 */
// What someone without admin rights sees: their chats and their media.
const MEMBER_TABS = ['chat', 'media'];
const parseHash = (allowed = ORDER) => {
  const [tab, ...rest] = window.location.hash.slice(1).split('/');
  const known = allowed.includes(tab) ? tab : allowed[0];
  const decode = (part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  let itemId = null;
  if (known === 'projects' && rest[0]) itemId = decode(rest[0]);
  if (known === 'github' && rest[0] && rest[1]) itemId = `${decode(rest[0])}/${decode(rest[1])}`.toLowerCase();
  // #chat/<conversation id>, #media/<image|audio|video>
  if ((known === 'chat' || known === 'media') && rest[0]) itemId = decode(rest[0]);
  return { tab: known, itemId };
};
const hashOf = (tab, itemId) => `#${tab}/${itemId.split('/').map(encodeURIComponent).join('/')}`;

// Sections slide in from the side of the tab you moved towards. On a right-to-left
// page the next tab is on the left, so the movement is mirrored.
const SIDE = document.documentElement.dir === 'rtl' ? -1 : 1;
const pageVariants = {
  enter: (direction) => ({ opacity: 0, x: direction * 28 * SIDE }),
  center: { opacity: 1, x: 0, transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
  exit: (direction) => ({ opacity: 0, x: direction * -28 * SIDE, transition: { duration: 0.16, ease: 'easeIn' } }),
};

/**
 * App shell. Owns the data of all three sections (so counts are always known
 * and switching tabs never reloads) and keeps the tab in the URL hash, so
 * #links and #files are linkable and the back button works.
 */
export function Dashboard() {
  const { user } = useAuth();
  const admin = Boolean(user?.isAdmin);
  const sections = admin ? SECTIONS : SECTIONS.filter((section) => MEMBER_TABS.includes(section.id));
  const allowed = sections.map((section) => section.id);
  const [view, setView] = useState(() => ({ ...parseHash(allowed), direction: 0 }));
  const [queries, setQueries] = useState({ projects: '', github: '', links: '', files: '' });
  const [settingsOpen, setSettingsOpen] = useState(false);

  const health = useHealth();
  const projects = useProjects(health.limits, { enabled: admin });
  const links = useLinks({ enabled: admin });
  const files = useFiles(health.limits, { enabled: admin });
  const github = useGithub({ enabled: admin });

  // Chat conversations and media tabs change the URL without adding history entries.
  const selectItem = useCallback((tab, id) => {
    window.history.replaceState(null, '', id ? hashOf(tab, id) : `#${tab}`);
    setView((current) => (current.tab === tab ? { ...current, itemId: id } : current));
  }, []);
  const selectChat = useCallback((id) => selectItem('chat', id), [selectItem]);
  const selectMediaTab = useCallback((id) => selectItem('media', id), [selectItem]);
  const chat = useChat({ onSelect: selectChat });
  const media = useMedia();
  const { setActiveId: setChatId } = chat;
  useEffect(() => {
    if (view.tab === 'chat') setChatId(view.itemId);
  }, [view.tab, view.itemId, setChatId]);

  // Coming back to the chat or the studio reopens the last conversation or media tab.
  const lastItem = useRef({});
  useEffect(() => {
    if (view.tab === 'chat' || view.tab === 'media') lastItem.current[view.tab] = view.itemId;
  }, [view.tab, view.itemId]);

  useEffect(() => {
    const sync = () => {
      const next = parseHash(allowed);
      if (!next.itemId) openedAt.current = null;
      setView((current) =>
        current.tab === next.tab && current.itemId === next.itemId
          ? current
          : {
              ...next,
              direction: current.tab === next.tab ? current.direction : Math.sign(ORDER.indexOf(next.tab) - ORDER.indexOf(current.tab)),
            },
      );
    };
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  // An open project lives in the URL (#projects/<id>): that's the link Share copies, and Back closes the dialog.
  const openedAt = useRef(null);
  const openItem = useCallback((tab, id) => {
    window.history.pushState({ stashProject: id }, '', hashOf(tab, id));
    openedAt.current = { id, length: window.history.length };
    setView((current) => ({ ...current, itemId: id }));
  }, []);
  const openProject = useCallback((id) => openItem('projects', id), [openItem]);
  const openRepo = useCallback((id) => openItem('github', id), [openItem]);
  const closeItem = useCallback(() => {
    const opened = openedAt.current;
    openedAt.current = null;
    // Step back only when nothing was added to history since opening. Navigating inside a
    // live preview adds entries (iframes share the page's history), and then Back would
    // undo that navigation instead of closing the dialog.
    if (opened && window.history.state?.stashProject === opened.id && window.history.length === opened.length) {
      window.history.back();
      return;
    }
    window.history.replaceState(null, '', `#${window.location.hash.slice(1).split('/')[0] || allowed[0]}`);
    setView((current) => ({ ...current, itemId: null }));
  }, []);

  const changeTab = useCallback((tab) => {
    const remembered = lastItem.current[tab];
    const target = remembered ? hashOf(tab, remembered).slice(1) : tab;
    if (window.location.hash.slice(1) !== target) window.location.hash = target;
  }, []);

  const setQuery = useCallback((tab) => (value) => setQueries((current) => ({ ...current, [tab]: value })), []);

  // When the server comes back after being offline, reload every section.
  const wasOffline = useRef(false);
  const { reload: reloadProjects } = projects;
  const { reload: reloadLinks } = links;
  const { reload: reloadFiles } = files;
  const { reload: reloadGithub } = github;
  useEffect(() => {
    if (health.status === 'error') wasOffline.current = true;
    if (health.status === 'ok' && wasOffline.current && admin) {
      wasOffline.current = false;
      reloadProjects();
      reloadLinks();
      reloadFiles();
      reloadGithub();
    }
  }, [health.status, admin, reloadProjects, reloadLinks, reloadFiles, reloadGithub]);

  const counts = {
    projects: projects.status === 'ready' ? projects.items.length : null,
    github: github.connection.data?.connected && github.reposStatus === 'ready' ? github.repos.length : null,
    links: links.status === 'ready' ? links.items.length : null,
    files: files.status === 'ready' ? files.items.length : null,
  };

  return (
    <div className="min-h-dvh">
      <TopBar tab={view.tab} onTabChange={changeTab} counts={counts} health={health} sections={sections} onOpenSettings={admin ? () => setSettingsOpen(true) : undefined} />
      {/* The chat fills the window below the top bar, so it has no space for scrolling underneath. */}
      <main className={cx('mx-auto max-w-[1240px] px-4 sm:px-8', view.tab === 'chat' ? 'sm:pb-6' : 'pb-28')}>
        {/* No initial={false} here: it would also block the entrance animations of anything
            mounted later inside the section (click rings, highlights). The first section fades in. */}
        <AnimatePresence mode="wait" custom={view.direction}>
          <motion.section
            key={view.tab}
            id={`panel-${view.tab}`}
            role="tabpanel"
            aria-labelledby={`tab-${view.tab}`}
            custom={view.direction}
            variants={pageVariants}
            initial="enter"
            animate="center"
            exit="exit"
          >
            {view.tab === 'projects' && (
              <ProjectsSection
                state={projects}
                query={queries.projects}
                onQueryChange={setQuery('projects')}
                openId={view.itemId}
                onOpen={openProject}
                onClose={closeItem}
              />
            )}
            {view.tab === 'github' && (
              <GithubSection
                github={github}
                query={queries.github}
                onQueryChange={setQuery('github')}
                openId={view.itemId}
                onOpen={openRepo}
                onClose={closeItem}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            )}
            {view.tab === 'chat' && <ChatSection chat={chat} github={github} onOpenSettings={() => setSettingsOpen(true)} />}
            {view.tab === 'media' && <MediaSection media={media} tab={view.itemId ?? 'image'} onTabChange={selectMediaTab} />}
            {view.tab === 'links' && <LinksSection state={links} query={queries.links} onQueryChange={setQuery('links')} />}
            {view.tab === 'files' && <FilesSection state={files} query={queries.files} onQueryChange={setQuery('files')} />}
          </motion.section>
        </AnimatePresence>
      </main>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} github={github} ai={health.ai} media={health.media} />
    </div>
  );
}
