/**
 * Before the dashboard: signing in, creating an account, resetting a password (and choosing a new
 * one from the email's link). Shown until Supabase has a session.
 */
import { ArrowRight, Eye, EyeOff, LoaderCircle, MailCheck } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/Button.jsx';
import { Wordmark } from '../../components/layout/TopBar.jsx';
import { cx } from '../../lib/cx.js';
import { useAuth } from './AuthProvider.jsx';

const MIN_PASSWORD = 8;
const FIELD = 'h-11 w-full rounded-xl border border-line-strong bg-paper px-3.5 text-[15px] text-ink transition-colors placeholder:text-mist focus:border-ink focus:outline-none';

const TITLES = {
  signin: ['ברוכים הבאים ל-Stash', 'הנתב החכם למודלי AI: צוות פיתוח, חיפוש ברשת וזיכרון שלומד אתכם.'],
  signup: ['יצירת חשבון', 'השיחות והזיכרון שלכם נשמרים בחשבון, ורק אתם רואים אותם.'],
  reset: ['איפוס סיסמה', 'נשלח לכם קישור לבחירת סיסמה חדשה.'],
  recovery: ['סיסמה חדשה', 'בחרו סיסמה חדשה לחשבון.'],
};

// The field and its eye share one bordered row, so the eye has a place of its own and never covers the password:
// the page's direction puts it at the row's end (the left, in Hebrew), while the password stays left-to-right, as
// it's typed. (An eye laid over an input with a direction of its own lands on one side while the input's room for
// it is on the other: the input's padding follows the input's direction, the eye's position the page's.)
function Password({ id, value, onChange, autoComplete }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex h-11 w-full rounded-xl border border-line-strong bg-paper transition-colors focus-within:border-ink">
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        dir="ltr"
        required
        minLength={autoComplete === 'new-password' ? MIN_PASSWORD : undefined}
        autoComplete={autoComplete}
        value={value}
        onChange={onChange}
        className="min-w-0 flex-1 rounded-xl bg-transparent px-3.5 text-start text-[15px] text-ink placeholder:text-mist focus:outline-none"
      />
      <button
        type="button"
        onClick={() => setShown(!shown)}
        aria-label={shown ? 'הסתרת הסיסמה' : 'הצגת הסיסמה'}
        aria-pressed={shown}
        aria-controls={id}
        className="grid w-11 shrink-0 place-items-center rounded-xl text-mist transition-colors hover:text-ink"
      >
        {shown ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
      </button>
    </div>
  );
}

export function AuthScreen() {
  const auth = useAuth();
  const [mode, setMode] = useState('signin');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  // Signed out after an entry the server refused, the screen opens saying why.
  const [error, setError] = useState(() => auth.error ?? null);
  const [sent, setSent] = useState(null); // 'confirm' | 'reset'
  const current = auth.recovery ? 'recovery' : mode;
  const set = (field) => (event) => setForm({ ...form, [field]: event.target.value });
  const go = (next) => {
    setMode(next);
    setError(null);
    setSent(null);
  };

  const submit = async (event) => {
    event.preventDefault();
    // Checked here rather than by the browser, so every message is in the page's words.
    if (current !== 'recovery' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return setError('כתבו כתובת אימייל תקינה.');
    if (current === 'signin' && !form.password) return setError('כתבו את הסיסמה.');
    if ((current === 'signup' || current === 'recovery') && form.password.length < MIN_PASSWORD) {
      return setError(`הסיסמה צריכה להיות לפחות ${MIN_PASSWORD} תווים.`);
    }
    setBusy(true);
    setError(null);
    try {
      // A good password goes straight on into the dashboard: signIn resolves once the dashboard can open (the gate
      // then swaps this screen for it), so the button keeps its spinner until then.
      if (current === 'signin') setError(await auth.signIn(form.email.trim(), form.password));
      if (current === 'signup') {
        const result = await auth.signUp(form.email.trim(), form.password, form.name.trim());
        if (result.error) setError(result.error);
        else if (result.confirm) setSent('confirm');
      }
      if (current === 'reset') {
        const problem = await auth.resetPassword(form.email.trim());
        if (problem) setError(problem);
        else setSent('reset');
      }
      if (current === 'recovery') setError(await auth.updatePassword(form.password));
    } finally {
      setBusy(false);
    }
  };

  const [title, subtitle] = TITLES[current];
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden bg-paper px-4 py-10">
      <div aria-hidden="true" className="pointer-events-none absolute -top-40 start-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(99_102_241/0.16),transparent)] rtl:translate-x-1/2" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-48 end-[-10%] h-[440px] w-[640px] rounded-full bg-[radial-gradient(closest-side,rgb(16_185_129/0.12),transparent)]" />
      <main className="relative w-full max-w-[420px]">
        <div className="mb-6 flex justify-center">
          <Wordmark />
        </div>
        <section aria-labelledby="auth-title" className="rounded-3xl border border-line bg-surface/95 p-7 shadow-[0_28px_70px_-28px_rgb(13_16_22/0.45)] backdrop-blur-sm sm:p-8">
          {sent ? (
            <div className="text-center" role="status">
              <span className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-sunken text-ink">
                <MailCheck size={22} aria-hidden="true" />
              </span>
              <h1 id="auth-title" className="text-[21px] font-bold text-ink">
                בדקו את תיבת הדואר
              </h1>
              <p className="mt-2 text-[14.5px] leading-relaxed text-graphite">
                שלחנו קישור אל <bdi dir="ltr" className="font-medium text-ink">{form.email.trim()}</bdi>. לחצו עליו כדי {sent === 'confirm' ? 'לאשר את החשבון' : 'לבחור סיסמה חדשה'}.
              </p>
              <Button className="mt-6 w-full" onClick={() => go('signin')}>
                חזרה להתחברות
              </Button>
            </div>
          ) : (
            <>
              <h1 id="auth-title" className="text-[23px] font-bold text-ink">
                {title}
              </h1>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-graphite">{subtitle}</p>
              {(current === 'signin' || current === 'signup') && (
                <div role="tablist" aria-label="התחברות או הרשמה" className="mt-6 grid grid-cols-2 rounded-full bg-sunken p-1">
                  {[
                    ['signin', 'התחברות'],
                    ['signup', 'הרשמה'],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={current === id}
                      onClick={() => go(id)}
                      className={cx('h-9 rounded-full text-[14.5px] font-medium transition-colors', current === id ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(13_16_22/0.14)]' : 'text-graphite hover:text-ink')}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <form onSubmit={submit} className="mt-5 space-y-3.5" noValidate>
                {current === 'signup' && (
                  <div>
                    <label htmlFor="auth-name" className="mb-1.5 block text-[13.5px] font-medium text-graphite">
                      שם <span className="text-mist">(לא חובה)</span>
                    </label>
                    <input id="auth-name" autoComplete="name" value={form.name} onChange={set('name')} className={FIELD} />
                  </div>
                )}
                {current !== 'recovery' && (
                  <div>
                    <label htmlFor="auth-email" className="mb-1.5 block text-[13.5px] font-medium text-graphite">
                      אימייל
                    </label>
                    <input id="auth-email" type="email" dir="ltr" required autoComplete="email" value={form.email} onChange={set('email')} className={cx(FIELD, 'text-start')} />
                  </div>
                )}
                {current !== 'reset' && (
                  <div>
                    <div className="mb-1.5 flex items-baseline justify-between">
                      <label htmlFor="auth-password" className="text-[13.5px] font-medium text-graphite">
                        {current === 'recovery' ? 'סיסמה חדשה' : 'סיסמה'}
                      </label>
                      {current === 'signin' && (
                        <button type="button" onClick={() => go('reset')} className="text-[13px] text-graphite underline-offset-2 hover:text-ink hover:underline">
                          שכחתי סיסמה
                        </button>
                      )}
                    </div>
                    <Password id="auth-password" value={form.password} onChange={set('password')} autoComplete={current === 'signin' ? 'current-password' : 'new-password'} />
                    {current !== 'signin' && <p className="mt-1.5 text-[12.5px] text-mist">לפחות {MIN_PASSWORD} תווים.</p>}
                  </div>
                )}
                {error && (
                  <p role="alert" className="rounded-xl bg-danger/10 px-3.5 py-2.5 text-[14px] text-danger">
                    {error}
                  </p>
                )}
                <Button type="submit" variant="primary" className="h-11 w-full text-[15px]" disabled={busy}>
                  {busy && <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />}
                  {busy && current === 'signin' ? 'נכנסים…' : { signin: 'התחברות', signup: 'יצירת חשבון', reset: 'שליחת קישור לאיפוס', recovery: 'שמירת הסיסמה' }[current]}
                </Button>
              </form>
              {current === 'reset' && (
                <button type="button" onClick={() => go('signin')} className="mt-4 inline-flex items-center gap-1.5 text-[14px] text-graphite hover:text-ink">
                  <ArrowRight size={15} aria-hidden="true" />
                  חזרה להתחברות
                </button>
              )}
            </>
          )}
        </section>
        <p className="mt-5 text-center text-[12.5px] text-mist">החשבונות מנוהלים ב-Supabase: הסיסמה לא נשמרת ב-Stash.</p>
      </main>
    </div>
  );
}

/** Whatever keeps the dashboard from opening: loading, a server that's off, auth that isn't set up. */
export function AuthNotice({ title, text, action }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-paper px-4">
      <div className="w-full max-w-[440px] text-center">
        <div className="mb-5 flex justify-center">
          <Wordmark />
        </div>
        {title ? (
          <div role="status">
            <h1 className="text-[20px] font-bold text-ink">{title}</h1>
            {text && <p className="mt-2 text-[14.5px] leading-relaxed text-graphite">{text}</p>}
            {action}
          </div>
        ) : (
          <LoaderCircle size={22} className="mx-auto animate-spin text-mist" role="status" aria-label="טוען" />
        )}
      </div>
    </div>
  );
}
