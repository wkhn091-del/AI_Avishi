import { ArrowUp, ChevronDown, Film, Mic, Plus, Siren, Square, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { IconButton } from '../../components/ui/Button.jsx';
import { useToast } from '../../components/ui/Toaster.jsx';
import { cx } from '../../lib/cx.js';
import { formatBytes } from '../../lib/format.js';
import { EFFORT_LABELS, TOOLS } from './ChatMessage.jsx';
import { MemorySheet } from './MemorySheet.jsx';
import { ComposerMenu, FreeModelSheet, PremiumModelSheet, RepoSheet } from './sheets.jsx';
import { useSpeechInput } from './useSpeechInput.js';

const ACCEPTED = 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,video/mpeg,video/x-msvideo,video/3gpp';
const EFFORT_LEVELS = { low: 1, medium: 2, high: 3, extra: 4, max: 5 };

/** What the model pill says: the effort, then the model (or the router, or the free mode). */
function pillOf(chat) {
  const { workspace, settings, catalog } = chat;
  const effort = EFFORT_LABELS[settings.effort] ?? EFFORT_LABELS.medium;
  const level = EFFORT_LEVELS[settings.effort] ?? EFFORT_LEVELS.medium;
  let model;
  let name;
  let tone = null;
  if (workspace === 'premium' && settings.emergency) {
    model = (
      <>
        <Siren size={13} className="me-1 inline-block align-[-2px]" aria-hidden="true" />
        <bdi dir="ltr" className="font-semi-wide">
          Fable 5.1
        </bdi>
      </>
    );
    name = 'Fable 5.1, מצב חירום';
    tone = 'danger';
  } else if (workspace === 'premium') {
    const chosen = catalog.data.premium.models.find((item) => item.id === settings.premiumModel);
    model = chosen ? (
      <bdi dir="ltr" className="font-semi-wide">
        {chosen.label}
      </bdi>
    ) : (
      'אוטומטי'
    );
    name = chosen ? chosen.label : 'ניתוב אוטומטי';
  } else if (settings.freeMode === 'brainstorm') {
    model = 'סיעור מוחות';
    name = model;
  } else if (settings.freeMode === 'manual' && chat.freeModel) {
    model = <bdi dir="ltr">{chat.freeModel.split('/').pop()}</bdi>;
    name = chat.freeModel;
  } else {
    model = 'אוטומטי-חינמי';
    name = model;
  }
  return { effort, level, model, tone, label: `מודל ומאמץ: ${name}, מאמץ ${effort}` };
}

/** Five bars that fill with the effort level, like the bars of a project's fingerprint. */
function EffortMeter({ level }) {
  return (
    <span aria-hidden="true" className="flex h-3.5 shrink-0 items-end gap-[2px]">
      {[1, 2, 3, 4, 5].map((step) => (
        <span key={step} className={cx('w-[3px] rounded-full bg-current', step > level && 'opacity-25')} style={{ height: `${36 + step * 12.8}%` }} />
      ))}
    </span>
  );
}

/** The model selector inside the message box: effort meter, effort, model. Opens the model and effort sheet. */
function ModelPill({ chat, disabled, onClick }) {
  const pill = pillOf(chat);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-haspopup="dialog"
      aria-label={pill.label}
      title={pill.label}
      className={cx(
        'inline-flex h-9 min-w-0 items-center gap-2 rounded-full ps-3 pe-2.5 text-[13.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        pill.tone === 'danger' ? 'bg-danger/10 text-danger hover:bg-danger/15' : 'bg-sunken/80 text-ink hover:bg-sunken',
      )}
    >
      <EffortMeter level={pill.level} />
      <span className={cx('shrink-0', pill.tone === 'danger' ? 'text-danger/75' : 'text-graphite')}>{pill.effort}</span>
      <span className="min-w-0 truncate font-semibold">{pill.model}</span>
      <ChevronDown size={15} className="shrink-0 opacity-60" aria-hidden="true" />
    </button>
  );
}

function AttachmentChip({ item, onRemove }) {
  return (
    <div
      title={item.error ?? item.name}
      className={cx('flex items-center gap-2 rounded-2xl border py-1 ps-1 pe-1.5 text-[12.5px]', item.status === 'error' ? 'border-danger/50 text-danger' : 'border-line text-graphite')}
    >
      {item.preview ? (
        <img src={item.preview} alt="" className="size-10 rounded-xl object-cover" />
      ) : (
        <span className="grid size-10 place-items-center rounded-xl bg-sunken">
          <Film size={16} aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0">
        <bdi dir="auto" className="block max-w-32 truncate font-medium text-ink">
          {item.name}
        </bdi>
        <span className="block">
          {item.status === 'uploading' ? `מעלה… ${Math.round(item.progress * 100)}%` : item.status === 'error' ? 'ההעלאה נכשלה' : formatBytes(item.size)}
        </span>
      </span>
      <IconButton label={`הסרת ${item.name}`} onClick={onRemove}>
        <X size={14} aria-hidden="true" />
      </IconButton>
    </div>
  );
}

const ROUND = 'grid size-9 shrink-0 place-items-center rounded-full transition-colors';

/**
 * The floating message box. Attachments sit above the prompt, and one row of
 * controls below it: "+" (files, media generators, a GitHub repository), the
 * model pill (model and effort in one sheet), dictation, and send or stop.
 * Files can also be dropped or pasted in the premium workspace.
 */
export function Composer({ chat, github, onOpenSettings }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [sheet, setSheet] = useState(null);
  const [dragging, setDragging] = useState(false);
  const field = useRef(null);
  const fileInput = useRef(null);
  const galleryInput = useRef(null);
  const dictatedAfter = useRef('');
  const streaming = Boolean(chat.live || chat.mediaLive);
  const tool = TOOLS[chat.tool];
  const { workspace, settings, catalog } = chat;
  const uploading = chat.attachments.some((item) => item.status === 'uploading');
  const blocked = chat.attachments.length > 0 && workspace !== 'premium';
  const emergency = workspace === 'premium' && settings.emergency;
  const canSend = tool ? Boolean(text.trim()) && !streaming : Boolean(text.trim()) && !uploading && !blocked;

  // Dictated words go after whatever was already typed.
  const speech = useSpeechInput({
    onText: (heard) => {
      const typed = dictatedAfter.current;
      setText(heard ? `${typed}${typed && !/\s$/.test(typed) ? ' ' : ''}${heard}` : typed);
    },
    onError: (message) => toast.error(message),
  });

  const addFiles = (files) => {
    const problems = chat.addFiles(files);
    if (problems.length) toast.error(problems.join(' '));
  };

  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [text]);

  const submit = () => {
    if (speech.listening) speech.cancel();
    if (chat.tool) {
      // A generator is selected: the prompt goes to Pollinations, not to a chat model.
      const prompt = text.trim();
      if (!prompt || streaming) return;
      setText('');
      chat
        .generate({ kind: chat.tool, prompt })
        .then((result) => result === 'aborted' && setText(prompt))
        .catch((error) => {
          setText(prompt);
          toast.error(error.message);
        });
      return;
    }
    const content = text.trim();
    if (!content || streaming || uploading || blocked) return;
    setText('');
    chat.send({ content }).catch((error) => {
      setText(content);
      toast.error(error.message);
    });
  };

  const dictate = () => {
    if (speech.listening) {
      speech.stop();
      return;
    }
    dictatedAfter.current = text;
    speech.start();
  };

  const insertRepo = (fullName) => {
    setText((current) => `${current}${current && !/\s$/.test(current) ? ' ' : ''}@${fullName} `);
    requestAnimationFrame(() => field.current?.focus());
  };

  let placeholder = workspace === 'premium' ? 'כתבו הודעה…' : 'כתבו הודעה למודלים החינמיים…';
  if (chat.attachments.length) placeholder = 'מה לעשות עם הקובץ?';
  if (tool) placeholder = tool.placeholder;
  if (speech.listening) placeholder = 'מקשיב… דברו עכשיו';

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onDragOver={(event) => {
        if (workspace === 'premium' && event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (workspace !== 'premium' || !event.dataTransfer.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        setDragging(false);
        addFiles(event.dataTransfer.files);
      }}
      className="relative shrink-0 px-2.5 pb-2.5 sm:px-5 sm:pb-4"
    >
      {/* Messages fade out as they scroll under the floating box. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-full h-8 bg-linear-to-t from-surface to-transparent" />
      <div
        className={cx(
          'relative mx-auto max-w-3xl rounded-[26px] border bg-surface transition-[border-color,box-shadow]',
          'shadow-[0_12px_32px_-14px_rgb(13_16_22/0.3),0_2px_8px_-3px_rgb(13_16_22/0.1)] dark:shadow-[0_12px_32px_-14px_rgb(0_0_0/0.75)]',
          emergency || speech.listening ? 'border-danger/50' : 'border-line-strong focus-within:border-graphite',
          dragging && 'border-ink ring-2 ring-ink/10',
        )}
      >
        {chat.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {chat.attachments.map((item) => (
              <AttachmentChip key={item.localId} item={item} onRemove={() => chat.removeAttachment(item.localId)} />
            ))}
            {blocked && <p className="w-full text-[12.5px] text-danger">צירוף קבצים זמין רק בסביבת הפרימיום. עברו לפרימיום או הסירו את הקבצים.</p>}
          </div>
        )}
        <textarea
          ref={field}
          rows={1}
          // Empty, the box follows the page (right to left); with text, the text's own direction.
          dir={text ? 'auto' : undefined}
          value={text}
          readOnly={speech.listening}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files].filter((file) => /^(image|video)\//.test(file.type));
            if (files.length && workspace === 'premium') {
              event.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && speech.listening) {
              event.preventDefault();
              speech.stop();
            } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          aria-label="הודעה"
          className="block max-h-[220px] min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15.5px] leading-relaxed outline-none placeholder:text-mist"
        />
        <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-2.5">
          <button
            type="button"
            onClick={() => setSheet('menu')}
            aria-label="הוספה: קבצים, יצירת מדיה ומאגר GitHub"
            aria-haspopup="dialog"
            className={cx(ROUND, 'border border-line text-ink hover:bg-sunken')}
          >
            <Plus size={19} aria-hidden="true" />
          </button>
          {tool ? (
            <span className="inline-flex h-9 min-w-0 items-center gap-1.5 rounded-full bg-ink ps-3 pe-1.5 text-[13.5px] font-medium text-on-ink">
              <tool.icon size={14} aria-hidden="true" />
              <span className="truncate">{tool.label}</span>
              <button
                type="button"
                onClick={() => chat.setTool(null)}
                aria-label={`ביטול ${tool.label}`}
                className="grid size-6 shrink-0 place-items-center rounded-full transition-colors hover:bg-on-ink/20"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </span>
          ) : (
            <ModelPill chat={chat} disabled={streaming} onClick={() => setSheet('model')} />
          )}
          <span className="min-w-2 flex-1" />
          {speech.supported && (
            <button
              type="button"
              onClick={dictate}
              aria-pressed={speech.listening}
              aria-label={speech.listening ? 'סיום ההקלטה' : 'הקלטה קולית'}
              title={speech.listening ? 'סיום ההקלטה' : 'הקלטה קולית (עברית)'}
              className={cx(ROUND, speech.listening ? 'mic-live bg-danger text-on-ink' : 'text-graphite hover:bg-sunken hover:text-ink')}
            >
              <Mic size={18} aria-hidden="true" />
            </button>
          )}
          {streaming ? (
            <button type="button" onClick={chat.mediaLive ? chat.stopMedia : chat.stop} aria-label={chat.mediaLive ? 'עצירת היצירה' : 'עצירת התשובה'} className={cx(ROUND, 'bg-ink text-on-ink hover:opacity-90')}>
              <Square size={13} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label={uploading ? 'ממתין לסיום ההעלאה' : 'שליחה'}
              className={cx(ROUND, 'bg-ink text-on-ink hover:opacity-90 disabled:cursor-not-allowed disabled:bg-sunken disabled:text-mist disabled:hover:opacity-100')}
            >
              <ArrowUp size={18} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <p className="mx-auto mt-2 hidden max-w-3xl text-center text-[12px] text-mist sm:block">
        Enter לשליחה, Shift+Enter לשורה חדשה. <bdi dir="ltr">@owner/repo</bdi> מצרף מאגר GitHub להקשר.
      </p>
      <span className="sr-only" aria-live="polite">
        {speech.listening ? 'ההקלטה פעילה. דברו, ואז הקישו על המיקרופון כדי לסיים.' : ''}
      </span>

      {workspace === 'premium' ? (
        <PremiumModelSheet
          open={sheet === 'model'}
          onClose={() => setSheet(null)}
          catalog={catalog.data}
          settings={settings}
          handoff={chat.handoff}
          pipeline={chat.pipeline}
          research={chat.research}
          memory={chat.memory}
          onChange={chat.update}
          onOpenMemory={() => setSheet('memory')}
        />
      ) : (
        <FreeModelSheet
          open={sheet === 'model'}
          onClose={() => setSheet(null)}
          catalog={catalog.data}
          settings={{ ...settings, freeProvider: chat.freeProvider?.id, freeModel: chat.freeModel }}
          research={chat.research}
          memory={chat.memory}
          onChange={chat.update}
          onOpenMemory={() => setSheet('memory')}
        />
      )}
      <MemorySheet open={sheet === 'memory'} onClose={() => setSheet(null)} />
      <RepoSheet open={sheet === 'repos'} onClose={() => setSheet(null)} github={github} onPick={insertRepo} onOpenSettings={onOpenSettings} />
      <ComposerMenu
        open={sheet === 'menu'}
        onClose={() => setSheet(null)}
        catalog={catalog.data}
        workspace={workspace}
        tool={chat.tool}
        onPickFiles={() => fileInput.current?.click()}
        onPickGallery={() => galleryInput.current?.click()}
        onGenerate={(kind) => {
          chat.setTool(kind);
          // After the sheet has handed focus back to "+", move it to the prompt.
          setTimeout(() => field.current?.focus(), 60);
        }}
        onPickRepo={() => setSheet('repos')}
      />
      <input
        ref={galleryInput}
        type="file"
        multiple
        hidden
        accept="image/*,video/*"
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        accept={ACCEPTED}
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = '';
        }}
      />
    </form>
  );
}
