import { MotionConfig } from 'framer-motion';
import { Dashboard } from './components/layout/Dashboard.jsx';
import { ToastProvider } from './components/ui/Toaster.jsx';
import { AuthGate } from './features/auth/AuthGate.jsx';
import { AuthProvider } from './features/auth/AuthProvider.jsx';

export default function App() {
  return (
    // "user": transform animations are skipped when the OS asks for reduced motion.
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <AuthProvider>
          <AuthGate>
            <Dashboard />
          </AuthGate>
        </AuthProvider>
      </ToastProvider>
    </MotionConfig>
  );
}
