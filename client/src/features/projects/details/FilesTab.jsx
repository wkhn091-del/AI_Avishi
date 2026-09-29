import { FileSearch, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cx } from '../../../lib/cx.js';
import { pluralize } from '../../../lib/format.js';
import { CodeViewer } from './CodeViewer.jsx';
import { FileIcon, FileTree, treeRowClass } from './FileTree.jsx';
import { Loading, Notice, RetryButton } from './parts.jsx';
import { useProjectTree } from './projectFiles.js';
import { sourceOf } from './sources.js';

const MAX_FILTER_RESULTS = 200;

function flatten(node, out = []) {
  for (const child of node.children) {
    if (child.type === 'dir') flatten(child, out);
    else out.push(child);
  }
  return out;
}

const parentsOf = (filePath) => {
  const parts = filePath.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
};

/** File explorer (tree + filter) beside the code viewer. On phones, one pane at a time. */
export default function FilesTab({ project }) {
  const tree = useProjectTree(sourceOf(project));
  const [selected, setSelected] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [filter, setFilter] = useState('');
  const [pane, setPane] = useState('tree');
  const files = useMemo(() => (tree.data ? flatten(tree.data.tree) : []), [tree.data]);

  // Start on something useful: the README, else an entry point, else the first file.
  useEffect(() => {
    if (!files.length || selected !== null) return;
    const paths = new Set(files.map((file) => file.path));
    const readme = files.find((file) => /^readme(\.(md|markdown|txt))?$/i.test(file.path));
    const initial = readme?.path ?? (project.entryPoints ?? []).find((entry) => paths.has(entry)) ?? files[0].path;
    setSelected(initial);
    setExpanded(new Set(parentsOf(initial)));
  }, [files, selected, project.entryPoints]);

  const select = (filePath) => {
    setSelected(filePath);
    setPane('viewer');
  };
  const toggle = (folder) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });

  if (tree.status === 'loading') return <Loading label="קריאת הארכיון…" />;
  if (tree.status === 'error') {
    return (
      <Notice tone="error" title="קריאת הארכיון נכשלה" actions={<RetryButton onClick={tree.retry} />}>
        {tree.error.message}
      </Notice>
    );
  }
  if (!files.length) {
    return (
      <Notice icon={FileSearch} title="אין קבצים להצגה">
        {tree.data.hidden.count ? 'כל הקבצים בארכיון נמצאים בתיקיות מוסתרות, כמו node_modules.' : 'הארכיון ריק.'}
      </Notice>
    );
  }

  const query = filter.trim().toLowerCase();
  const matches = query ? files.filter((file) => file.path.toLowerCase().includes(query)).slice(0, MAX_FILTER_RESULTS) : [];

  return (
    <div className="flex h-full min-h-0">
      <aside
        aria-label="קבצי הפרויקט"
        className={cx('min-h-0 w-full flex-col sm:flex sm:w-[300px] sm:shrink-0 sm:border-e sm:border-line', pane === 'tree' ? 'flex' : 'hidden')}
      >
        <div className="shrink-0 border-b border-line p-3">
          <div className="relative flex items-center">
            <Search size={15} className="pointer-events-none absolute start-3 text-mist" aria-hidden="true" />
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && filter) {
                  event.stopPropagation();
                  setFilter('');
                }
              }}
              placeholder="סינון קבצים"
              aria-label="סינון קבצים"
              dir="auto"
              className="h-9 w-full rounded-full border border-line bg-surface px-9 text-[14px] placeholder:text-mist focus:border-line-strong"
            />
            {filter && (
              <button
                type="button"
                onClick={() => setFilter('')}
                aria-label="ניקוי הסינון"
                className="absolute end-1.5 inline-flex size-6 items-center justify-center rounded-full text-mist hover:bg-sunken hover:text-ink"
              >
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1.5">
          {!query && <FileTree node={tree.data.tree} expanded={expanded} onToggle={toggle} selected={selected} onSelect={select} />}
          {query && matches.length > 0 && (
            <ul>
              {matches.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    aria-current={file.path === selected ? 'true' : undefined}
                    onClick={() => select(file.path)}
                    className={cx(treeRowClass(file.path === selected), 'ps-3')}
                  >
                    <FileIcon name={file.name} />
                    <span className="min-w-0 flex-1">
                      <bdi className="block truncate">{file.name}</bdi>
                      <bdi className="block truncate text-[12px] text-mist">{file.path}</bdi>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {query && matches.length === 0 && <p className="px-4 py-6 text-center text-[13.5px] text-graphite">אין קבצים שמתאימים לסינון.</p>}
        </div>

        <div className="shrink-0 space-y-0.5 border-t border-line px-4 py-2.5 text-[12.5px] text-graphite">
          <p>{pluralize(tree.data.fileCount, 'קובץ אחד', 'קבצים')}</p>
          {tree.data.hidden.count > 0 && (
            <p className="text-mist">
              {pluralize(tree.data.hidden.count, 'קובץ אחד מוסתר', 'קבצים מוסתרים')} בתיקיות כמו{' '}
              <bdi>{tree.data.hidden.folders.slice(0, 2).join(', ')}</bdi>
            </p>
          )}
          {tree.data.truncated && <p className="text-mist">מוצגים 20,000 הקבצים הראשונים.</p>}
        </div>
      </aside>

      <section aria-label="תוכן הקובץ" className={cx('min-h-0 min-w-0 flex-1 flex-col sm:flex', pane === 'viewer' ? 'flex' : 'hidden')}>
        {selected && <CodeViewer key={selected} project={project} path={selected} onBack={() => setPane('tree')} />}
      </section>
    </div>
  );
}
