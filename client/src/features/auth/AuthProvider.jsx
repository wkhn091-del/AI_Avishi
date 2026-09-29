/**
 * Signing in, with Supabase Auth. The server says which Supabase project to use (GET /api/auth/config:
 * its URL and publishable key, both public), so one server .env configures both sides.
 *
 * Supabase's client keeps the session and refreshes its token. After every sign-in and refresh, the
 * token goes to our API helpers (the Authorization header) and to the server, which sets an httpOnly
 * cookie so images, videos and downloads load too (they can't send headers).
 *
 * Signing in resolves only once the dashboard can open: the server's part (its cookie, and who this is) runs
 * right away rather than only after Supabase's SIGNED_IN event, which asks for the same handshake (it runs
 * once). A server that doesn't answer within ENTER_SECONDS gets a message, not a screen that seems to do nothing.
 */
import { createClient } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CROSS_ORIGIN, refreshLinkToken, request, setAuth } from '../../lib/api.js';

const AuthContext = createContext(null);

/** `{ status, user, recovery, error, signIn, signUp, resetPassword, updatePassword, signOut, retry }` */
export const useAuth = () => useContext(AuthContext);

const ENTER_SECONDS = 20;
const TAKEN = 'האימייל הזה כבר רשום במערכת';

// Supabase's error codes, in the words the screen uses.
const MESSAGES = {
  invalid_credentials: 'האימייל או הסיסמה שגויים.',
  email_not_confirmed: 'צריך לאשר את האימייל קודם: חפשו את הקישור שנשלח אליכם.',
  // An address that's already registered, when Supabase says so (sign-up with email confirmation off).
  user_already_exists: TAKEN,
  email_exists: TAKEN,
  weak_password: 'הסיסמה חלשה מדי. בחרו סיסמה ארוכה יותר, עם אותיות ומספרים.',
  same_password: 'זו הסיסמה הנוכחית. בחרו סיסמה אחרת.',
  email_address_invalid: 'כתובת האימייל אינה תקינה.',
  signup_disabled: 'ההרשמה סגורה כרגע.',
  over_email_send_rate_limit: 'נשלחו יותר מדי מיילים. נסו שוב בעוד כמה דקות.',
  over_request_rate_limit: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.',
};
export function authMessage(error) {
  if (!error) return null;
  if (MESSAGES[error.code]) return MESSAGES[error.code];
  if (error.name === 'AuthRetryableFetchError' || error.status === 0) return 'אין חיבור לשרת ההתחברות. בדקו את החיבור ונסו שוב.';
  return error.message || 'ההתחברות נכשלה.';
}

// The session cookie serves what the browser loads by itself when the app and the API share an origin. With the API
// elsewhere (VITE_API_URL) the browser wouldn't send it, and link tokens do that job (lib/api.js, resourceUrl).
const syncCookie = () => (CROSS_ORIGIN ? Promise.resolve() : request('/auth/session', { method: 'POST' }));
const clearCookie = () => (CROSS_ORIGIN ? Promise.resolve() : request('/auth/session', { method: 'DELETE' }).catch(() => {}));

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null, recovery: false, error: null });
  const client = useRef(null);
  const entering = useRef(null); // { token, promise }: one server handshake per session, however many ask for it
  const [attempt, setAttempt] = useState(0);

  const enter = useCallback((session) => {
    if (entering.current?.token === session.access_token) return entering.current.promise;
    const promise = (async () => {
      setAuth({ token: session.access_token });
      const signal = AbortSignal.timeout(ENTER_SECONDS * 1000);
      try {
        if (!CROSS_ORIGIN) await request('/auth/session', { method: 'POST', signal });
        const { user } = await request('/auth/me', { signal });
        await refreshLinkToken({ force: true });
        setState((current) => ({ ...current, status: 'signed-in', user, error: null }));
      } catch (error) {
        if (entering.current?.promise === promise) entering.current = null;
        setState((current) => ({ ...current, status: 'error', error: signal.aborted ? 'השרת לא ענה בזמן. נסו שוב בעוד רגע.' : error.message }));
      }
    })();
    entering.current = { token: session.access_token, promise };
    return promise;
  }, []);

  // keepError: signed out by Supabase after an entry the server refused (and a refresh didn't help), the sign-in
  // screen keeps saying why instead of coming back blank.
  const leave = useCallback((keepError = false) => {
    entering.current = null;
    setAuth({ token: null });
    clearCookie();
    setState((current) => ({ status: 'signed-out', user: null, recovery: false, error: keepError && current.status === 'error' ? current.error : null }));
  }, []);

  useEffect(() => {
    let subscription = null;
    let active = true;
    (async () => {
      let settings;
      try {
        settings = await request('/auth/config');
      } catch (error) {
        if (active) setState((current) => ({ ...current, status: 'offline', error: error.message }));
        return;
      }
      if (!active) return;
      if (!settings.configured) return setState((current) => ({ ...current, status: 'unconfigured' }));
      const supabase = (client.current ??= createClient(settings.supabaseUrl, settings.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'stash-auth' },
      }));
      // A request the server refused as signed out: refresh the session once, or sign out.
      setAuth({
        onUnauthorized: async () => {
          const { error } = await supabase.auth.refreshSession();
          if (error) await supabase.auth.signOut();
        },
      });
      ({
        data: { subscription },
      } = supabase.auth.onAuthStateChange((event, session) => {
        // Supabase asks not to call it from inside this callback: the work runs right after.
        setTimeout(() => {
          if (!active) return;
          if (event === 'PASSWORD_RECOVERY') setState((current) => ({ ...current, recovery: true }));
          if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') return session ? enter(session) : leave();
          if (event === 'TOKEN_REFRESHED' && session) {
            setAuth({ token: session.access_token });
            syncCookie().catch(() => {});
          }
          if (event === 'SIGNED_OUT') leave(true);
        }, 0);
      }));
    })();
    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, [attempt, enter, leave]);

  // The link token, when the API is on another origin: fresh every hour, and when the tab comes back after a while.
  useEffect(() => {
    if (!CROSS_ORIGIN || state.status !== 'signed-in') return undefined;
    const timer = setInterval(() => refreshLinkToken({ force: true }), 60 * 60_000);
    const onVisible = () => document.visibilityState === 'visible' && refreshLinkToken();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [state.status]);

  const value = useMemo(
    () => ({
      ...state,
      async signIn(email, password) {
        const { data, error } = await client.current.auth.signInWithPassword({ email, password });
        if (error) return authMessage(error);
        await enter(data.session);
        return null;
      },
      /** Resolves to `{ error }`, or `{ confirm: true }` when Supabase sent a confirmation email first. */
      async signUp(email, password, name) {
        const { data, error } = await client.current.auth.signUp({
          email,
          password,
          options: { data: name ? { full_name: name } : {}, emailRedirectTo: window.location.origin },
        });
        if (error) return { error: authMessage(error) };
        // With email confirmation on (Supabase's default), an address that's already registered gets no error: so
        // that nobody can probe which addresses have accounts, Supabase answers with a stand-in user that has no
        // identities, and sends no email.
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) return { error: TAKEN };
        // With confirmation off, the new account is signed in: straight on into the dashboard, like signIn.
        if (data.session) await enter(data.session);
        return { confirm: !data.session };
      },
      async resetPassword(email) {
        const { error } = await client.current.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
        return authMessage(error);
      },
      async updatePassword(password) {
        const { error } = await client.current.auth.updateUser({ password });
        if (!error) setState((current) => ({ ...current, recovery: false }));
        return authMessage(error);
      },
      async signOut() {
        await client.current?.auth.signOut().catch(() => {});
        leave();
      },
      retry: () => setAttempt((count) => count + 1),
    }),
    [state, leave, enter],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
