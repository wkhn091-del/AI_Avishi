import { CircleAlert, ExternalLink, KeyRound, LoaderCircle, X } from 'lucide-react';
import { useState } from 'react';
import { isolate } from '../../lib/format.js';
import { Button, IconButton } from '../ui/Button.jsx';
import { ConfirmButton } from '../ui/ConfirmButton.jsx';
import { Modal } from '../ui/Modal.jsx';
import { useToast } from '../ui/Toaster.jsx';

const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
const Spinner = (props) => <LoaderCircle {...props} className="animate-spin" />;

/**
 * Settings: connect GitHub with a personal access token (validated with
 * GitHub before it is saved on the server), and see which AI model writes
 * the summaries and explanations.
 */
export function SettingsModal({ open, onClose, github, ai, media }) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const data = github.connection.data;

  const save = async (event) => {
    event.preventDefault();
    if (!token.trim()) return setError('הדביקו טוקן כדי להתחבר.');
    setBusy('save');
    setError(null);
    try {
      const status = await github.saveToken(token.trim());
      setToken('');
      toast.success(`החיבור ל-GitHub הצליח (${isolate(`@${status.user.login}`)})`);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    try {
      await github.removeToken();
      toast.success('הטוקן הוסר');
    } catch (removeError) {
      toast.error(removeError.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="settings-title">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-6 py-4 sm:px-8">
        <h2 id="settings-title" className="flex-1 font-wide text-[22px] font-bold tracking-[-0.01em]">
          הגדרות
        </h2>
        <IconButton label="סגירה" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 space-y-9 overflow-y-auto overscroll-contain px-6 py-6 sm:px-8">
        <section aria-labelledby="settings-github">
          <h3 id="settings-github" className="text-[16px] font-semibold">
            חיבור ל-GitHub
          </h3>
          <Connection status={github.connection.status} data={data} />

          <form onSubmit={save} noValidate className="mt-5">
            <label htmlFor="github-token" className="text-[13px] font-medium text-graphite">
              טוקן גישה אישי (Personal Access Token)
            </label>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <input
                id="github-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="github_pat_…"
                className="h-10 min-w-0 flex-1 rounded-full border border-line-strong bg-surface px-4 font-mono text-[14px] placeholder:text-mist focus:border-graphite"
              />
              <Button type="submit" variant="primary" icon={busy === 'save' ? Spinner : KeyRound} disabled={busy === 'save'}>
                {data?.connected ? 'החלפת הטוקן' : 'שמירה וחיבור'}
              </Button>
            </div>
            {error && (
              <p role="alert" className="bidi-plain mt-2 text-[14px] text-danger" dir="auto">
                {error}
              </p>
            )}
          </form>

          <div className="mt-4 space-y-2 text-[13.5px] leading-relaxed text-graphite">
            <p>
              בטוקן מסוג Fine-grained מספיקות הרשאות קריאה בלבד ל-Contents ול-Metadata של המאגרים שתבחרו. בטוקן מסוג Classic צריך את
              ההרשאה <bdi>repo</bdi> כדי לראות גם מאגרים פרטיים.
            </p>
            <p>
              הטוקן נשמר רק במחשב הזה, בתיקייה <bdi>server/storage</bdi>, ונשלח רק אל <bdi>api.github.com</bdi>.
            </p>
            <a
              href={NEW_TOKEN_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-current"
            >
              יצירת טוקן ב-GitHub
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          </div>

          {data?.source === 'env' && (
            <p className="mt-4 rounded-xl bg-sunken px-4 py-3 text-[13.5px] leading-relaxed text-graphite">
              הטוקן הנוכחי נטען מהמשתנה GITHUB_TOKEN בקובץ server/.env. טוקן שתשמרו כאן יחליף אותו.
            </p>
          )}
          {data?.source === 'settings' && (
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <ConfirmButton
                label="הסרת הטוקן"
                confirmLabel="להסיר את הטוקן?"
                onConfirm={remove}
                disabled={busy === 'remove'}
                className="border border-line-strong"
              />
              {data.envToken && <span className="text-[13px] text-mist">אחרי ההסרה ייעשה שימוש בטוקן מקובץ server/.env.</span>}
            </div>
          )}
        </section>

        <section aria-labelledby="settings-ai">
          <h3 id="settings-ai" className="text-[16px] font-semibold">
            ספקי AI
          </h3>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-graphite">
            {!ai && 'בודקים…'}
            {ai && !ai.enabled && 'אין ספק מוגדר: הכותרות והתיאורים נכתבים בסיכום המובנה, והצ\'אט והסבר הקבצים לא זמינים.'}
            {ai?.enabled && ai.ensemble.length > 1 && `סיכומי פרויקטים נכתבים במקביל על ידי ${ai.ensemble.length} ספקים ומאוחדים לסיכום אחד בעברית.`}
            {ai?.enabled && ai.ensemble.length <= 1 && 'סיכומי הפרויקטים והסברי הקבצים נכתבים על ידי הספק הראשי; ספקים נוספים משמשים גיבוי.'}
          </p>
          {ai && (
            <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
              {ai.providers.map((provider) => (
                <ProviderRow key={provider.id} provider={provider} ai={ai} />
              ))}
            </ul>
          )}
          <p className="mt-2 text-[12.5px] leading-relaxed text-mist">
            המפתחות והמודלים נקראים מקובץ server/.env כשהשרת עולה. אחרי שינוי בקובץ, הפעילו את השרת מחדש.
          </p>
        </section>

        <section aria-labelledby="settings-media">
          <h3 id="settings-media" className="text-[16px] font-semibold">
            סטודיו מדיה
          </h3>
          <p className="mt-1.5 text-[14px] leading-relaxed text-graphite">
            {media?.configured ? (
              'מחובר ל-Pollinations: תמונות, הקראה, מוזיקה ווידאו.'
            ) : (
              <>
                לא מוגדר. צרו מפתח חינמי ב-
                <a href="https://enter.pollinations.ai/keys" target="_blank" rel="noopener noreferrer" className="font-medium text-ink underline decoration-line-strong underline-offset-4">
                  enter.pollinations.ai
                </a>{' '}
                והוסיפו אותו כ-POLLINATIONS_API_KEY בקובץ server/.env.
              </>
            )}
          </p>
        </section>
      </div>
    </Modal>
  );
}

function Connection({ status, data }) {
  if (status === 'loading' || !data) return <p className="mt-3 text-[14px] text-graphite">בודקים את החיבור…</p>;
  if (data.connected) {
    const { user, rateLimit } = data;
    return (
      <div className="mt-3 flex items-center gap-3 rounded-xl border border-line px-4 py-3">
        {user.avatarUrl && <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" className="size-10 shrink-0 rounded-full bg-sunken" />}
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold" dir="auto">
            {user.name ?? user.login}
          </p>
          <p className="flex flex-wrap gap-x-3 text-[13px] text-graphite">
            <bdi>@{user.login}</bdi>
            <span>
              טוקן <bdi>{data.tokenHint}</bdi>
            </span>
            <span>{data.source === 'env' ? 'מקובץ server/.env' : 'נשמר בהגדרות'}</span>
          </p>
          {rateLimit && (
            <p className="text-[12.5px] text-mist">
              נותרו {rateLimit.remaining.toLocaleString('he-IL')} מתוך {rateLimit.limit.toLocaleString('he-IL')} בקשות לשעה
            </p>
          )}
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[13px] font-medium text-ok">
          <span className="size-2 rounded-full bg-ok" aria-hidden="true" />
          מחובר
        </span>
      </div>
    );
  }
  if (data.error) {
    return (
      <p role="alert" className="mt-3 flex gap-2 rounded-xl border border-line px-4 py-3 text-[14px] text-danger">
        <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span className="bidi-plain" dir="auto">
          {data.error.message}
        </span>
      </p>
    );
  }
  return <p className="mt-3 text-[14px] text-graphite">עדיין לא מחובר.</p>;
}

function Badge({ children }) {
  return <span className="rounded-full bg-sunken px-2 py-0.5 text-[11.5px] font-medium text-graphite">{children}</span>;
}

function ProviderRow({ provider, ai }) {
  const roles = [
    provider.configured && ai.provider === provider.id && 'ראשי',
    ai.ensemble.includes(provider.id) && 'באנסמבל',
    ai.synthesizer === provider.id && 'מאחד',
  ].filter(Boolean);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
      <span className={provider.configured ? 'size-2 shrink-0 rounded-full bg-ok' : 'size-2 shrink-0 rounded-full bg-line-strong'} aria-hidden="true" />
      <span className="w-24 shrink-0 text-[14px] font-medium">{provider.name}</span>
      {provider.configured ? (
        <bdi dir="ltr" className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-graphite">
          {provider.model}
        </bdi>
      ) : (
        <span className="min-w-0 flex-1 text-[13px] text-mist">
          חסר <bdi dir="ltr">{provider.keyEnv}</bdi>
        </span>
      )}
      <span className="flex flex-wrap gap-1">
        {roles.map((role) => (
          <Badge key={role}>{role}</Badge>
        ))}
        <Badge>{provider.free ? 'חינמי' : 'בתשלום'}</Badge>
      </span>
      {!provider.configured && (
        <a href={provider.keyUrl} target="_blank" rel="noopener noreferrer" className="text-[13px] font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-current">
          קבלת מפתח
        </a>
      )}
    </li>
  );
}
