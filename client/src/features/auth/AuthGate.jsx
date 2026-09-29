/** The dashboard opens only for a signed-in person; until then, the sign-in screen (or why it can't open). */
import { Button } from '../../components/ui/Button.jsx';
import { useAuth } from './AuthProvider.jsx';
import { AuthNotice, AuthScreen } from './AuthScreen.jsx';
import { CreditsProvider } from '../credits/CreditsProvider.jsx';

export function AuthGate({ children }) {
  const auth = useAuth();
  if (auth.status === 'loading') return <AuthNotice />;
  if (auth.status === 'unconfigured') {
    return <AuthNotice title="ההתחברות עוד לא הוגדרה" text="הוסיפו את SUPABASE_URL ואת SUPABASE_PUBLISHABLE_KEY לקובץ server/.env והפעילו את השרת מחדש." />;
  }
  if (auth.status === 'offline' || auth.status === 'error') {
    return (
      <AuthNotice
        title={auth.status === 'offline' ? 'אין חיבור לשרת' : 'הכניסה לא הצליחה'}
        text={auth.error}
        action={
          <div className="mt-5 flex justify-center gap-2">
            <Button variant="primary" onClick={auth.retry}>
              לנסות שוב
            </Button>
            {auth.status === 'error' && <Button onClick={auth.signOut}>התנתקות</Button>}
          </div>
        }
      />
    );
  }
  if (auth.status !== 'signed-in' || auth.recovery) return <AuthScreen />;
  return <CreditsProvider>{children}</CreditsProvider>;
}
