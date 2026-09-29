import { Download, ExternalLink, Eye, FolderGit2, FolderTree, LayoutDashboard, LoaderCircle, Pencil, Save, ScanSearch, Share2, X } from 'lucide-react';
import { Suspense, lazy, useState } from 'react';
import { Button, IconButton } from '../../../components/ui/Button.jsx';
import { ConfirmButton } from '../../../components/ui/ConfirmButton.jsx';
import { Modal } from '../../../components/ui/Modal.jsx';
import { Tabs } from '../../../components/ui/Tabs.jsx';
import { useToast } from '../../../components/ui/Toaster.jsx';
import { copyText } from '../../../lib/clipboard.js';
import { quote } from '../../../lib/format.js';
import { kindOf } from '../projectVisuals.js';
import { OverviewTab } from './OverviewTab.jsx';
import { Loading } from './parts.jsx';
import { shareLink } from './sources.js';
import { resourceUrl } from '../../../lib/api.js';

// Loaded on first use: they bring the syntax highlighter and the Markdown renderer.
const FilesTab = lazy(() => import('./FilesTab.jsx'));
const PreviewTab = lazy(() => import('./PreviewTab.jsx'));

const TABS = [
  { id: 'overview', label: 'סקירה', icon: LayoutDashboard },
  { id: 'files', label: 'קבצים', icon: FolderTree },
  { id: 'preview', label: 'תצוגה מקדימה', icon: Eye },
];

const Spinner = (props) => <LoaderCircle {...props} className="animate-spin" />;

/**
 * The workspace for a ZIP project or a GitHub repository: overview, file
 * explorer with code viewer and AI explanations, and the preview. Header:
 * share and close. Footer: download the ZIP (or open the repository on
 * GitHub), re-analyze, edit, and delete (ZIP projects only). Escape leaves
 * edit mode first.
 *
 * @param {{ project: object|null, onClose: () => void, actions: ReturnType<import('../useProjects.js').useProjects> }} props
 */
export function ProjectDetailsModal({ project, onClose, actions }) {
  const toast = useToast();

  // Keep rendering the last project while the dialog animates out.
  const [shown, setShown] = useState(project);
  if (project && project !== shown) setShown(project);

  // Tab, edit and busy state belong to one project; reset them when another one opens.
  const [mode, setMode] = useState({ id: project?.id, tab: 'overview', editing: false, busy: null });
  if (project && project.id !== mode.id) setMode({ id: project.id, tab: 'overview', editing: false, busy: null });

  const [draft, setDraft] = useState(null);
  const [formError, setFormError] = useState(null);

  const p = shown;
  const isGithub = p?.source === 'github';
  const noun = isGithub ? 'המאגר' : 'הפרויקט';
  const { tab, editing, busy } = mode;
  const setBusy = (value) => setMode((current) => ({ ...current, busy: value }));
  const stopEditing = () => setMode((current) => ({ ...current, editing: false }));

  const startEditing = () => {
    setDraft({ title: p.title, description: p.description ?? '', tags: p.tags ?? [] });
    setFormError(null);
    setMode((current) => ({ ...current, editing: true, tab: 'overview' }));
  };

  const save = async (event) => {
    event.preventDefault();
    const title = draft.title.replace(/\s+/g, ' ').trim();
    if (!title) return setFormError('יש להזין כותרת לפרויקט.');
    setBusy('save');
    try {
      await actions.update(p.id, { title, description: draft.description.trim(), tags: draft.tags });
      setMode((current) => ({ ...current, editing: false, busy: null }));
      toast.success('השינויים נשמרו');
    } catch (error) {
      setFormError(error.message);
      setBusy(null);
    }
  };

  const reanalyze = async () => {
    setBusy('reanalyze');
    try {
      const updated = await actions.reanalyze(p.id);
      toast.success(`${noun} ${quote(updated.title)} נותח מחדש`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('delete');
    try {
      await actions.remove(p.id);
      toast.success(`הפרויקט ${quote(p.title)} נמחק`);
      onClose();
    } catch (error) {
      toast.error(error.message);
      setBusy(null);
    }
  };

  const share = async () => {
    try {
      await copyText(shareLink(p));
      toast.success('הקישור הועתק בהצלחה!');
    } catch {
      toast.error('ההעתקה נכשלה: הדפדפן חסם את הגישה ללוח.');
    }
  };

  const kind = !p ? null : isGithub && !p.analyzed ? { label: 'מאגר GitHub', icon: FolderGit2 } : kindOf(p.kind);
  const KindIcon = kind?.icon;
  const tabs = TABS.map((item) => ({ ...item, disabled: editing && item.id !== 'overview' }));

  return (
    <Modal open={Boolean(project)} onClose={editing ? stopEditing : onClose} labelledBy="project-dialog-title" size="xl">
      {p && (
        <>
          <header className="shrink-0 border-b border-line px-5 pt-5 sm:px-8 sm:pt-6">
            <div className="flex items-start gap-2 sm:gap-3">
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-2 text-[13px] text-graphite">
                  <KindIcon size={14} className="shrink-0" aria-hidden="true" />
                  <span className="shrink-0">{kind.label}</span>
                  {isGithub && <bdi className="truncate text-mist">{p.github.fullName}</bdi>}
                </p>
                <h2
                  id="project-dialog-title"
                  className="mt-1 truncate font-wide text-[24px] leading-tight font-bold tracking-[-0.01em] sm:text-[28px]"
                  dir="auto"
                  title={p.title}
                >
                  {p.title}
                </h2>
              </div>
              <Button size="sm" icon={Share2} onClick={share} className="mt-1">
                שתף
              </Button>
              <IconButton label="סגירה" onClick={onClose} className="mt-1">
                <X size={18} aria-hidden="true" />
              </IconButton>
            </div>
            <Tabs
              className="mt-3"
              label="אזורי הפרויקט"
              idPrefix="project-tab"
              items={tabs}
              value={tab}
              onChange={(next) => setMode((current) => ({ ...current, tab: next }))}
            />
          </header>

          <div role="tabpanel" id="project-tab-panel" aria-labelledby={`project-tab-${tab}`} className="relative min-h-0 flex-1">
            {tab === 'overview' && (
              <OverviewTab
                project={p}
                busy={busy}
                editing={editing}
                draft={draft}
                setDraft={setDraft}
                formError={formError}
                onSubmit={save}
                onAnalyze={actions.analyze ? () => actions.analyze(p.id).catch(() => {}) : undefined}
              />
            )}
            {tab !== 'overview' && (
              <Suspense fallback={<Loading />}>{tab === 'files' ? <FilesTab project={p} /> : <PreviewTab project={p} />}</Suspense>
            )}
          </div>

          <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-surface px-4 py-3 sm:px-7">
            {editing ? (
              <>
                <Button variant="primary" type="submit" form="project-edit-form" icon={busy === 'save' ? Spinner : Save} disabled={busy === 'save'}>
                  שמירת שינויים
                </Button>
                <Button variant="ghost" onClick={stopEditing}>
                  ביטול
                </Button>
              </>
            ) : (
              <>
                {isGithub ? (
                  <Button as="a" href={p.github.htmlUrl} target="_blank" rel="noopener noreferrer" icon={ExternalLink}>
                    פתיחה ב-GitHub
                  </Button>
                ) : (
                  <Button as="a" href={resourceUrl(`/api/projects/${p.id}/download`)} download icon={Download}>
                    הורדת ZIP
                  </Button>
                )}
                {isGithub && !p.analyzed ? null : busy === 'reanalyze' ? (
                  <Button disabled icon={Spinner}>
                    בניתוח…
                  </Button>
                ) : p.edited ? (
                  <ConfirmButton
                    label="ניתוח מחדש"
                    confirmLabel="להחליף את העריכות?"
                    icon={ScanSearch}
                    onConfirm={reanalyze}
                    disabled={Boolean(busy)}
                    className="border border-line-strong"
                  />
                ) : (
                  <Button icon={ScanSearch} onClick={reanalyze} disabled={Boolean(busy)}>
                    ניתוח מחדש
                  </Button>
                )}
                <span className="flex-1" />
                {!(isGithub && !p.analyzed) && (
                  <Button variant="ghost" icon={Pencil} onClick={startEditing} disabled={Boolean(busy)}>
                    עריכה
                  </Button>
                )}
                {!isGithub && <ConfirmButton label="מחיקה" confirmLabel="מחיקת הפרויקט" onConfirm={remove} disabled={Boolean(busy)} />}
              </>
            )}
          </footer>
        </>
      )}
    </Modal>
  );
}
