/**
 * Credits on the client: the balance from /api/auth/me, kept current by what the server sends with
 * every answer and media item, and the dialog a 402 opens (the badge opens it too, to explain it).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { UpgradeDialog } from './UpgradeDialog.jsx';

const CreditsContext = createContext(null);
const OFF = Object.freeze({ enabled: false, balance: null, unlimited: false, pricing: null, upgradeUrl: null, update: () => {}, handleError: () => false, open: () => {} });

/** The balance and what to do with it; with credits turned off on the server, a stand-in that does nothing. */
export const useCredits = () => useContext(CreditsContext) ?? OFF;

/** Whether an error says the credits ran out: a 402 response, or an answer stopped for it. */
export const isCreditError = (error) => error?.status === 402 || /^CREDITS_/.test(error?.code ?? '');

export function CreditsProvider({ children }) {
  const { user } = useAuth();
  const info = user?.credits ?? null;
  const [balance, setBalance] = useState(info?.balance ?? null);
  const [dialog, setDialog] = useState(null); // { reason: 'empty' | 'short' | 'info', needed, message }

  useEffect(() => setBalance(user?.credits?.balance ?? null), [user]);

  const update = useCallback((value) => {
    if (typeof value === 'number') setBalance(value);
  }, []);
  // A 402 (its details carry the balance), or an answer's error with the same fields: the balance, and the dialog.
  const handleError = useCallback((error) => {
    if (!isCreditError(error)) return false;
    const facts = error.details ?? error;
    if (typeof facts.credits === 'number') setBalance(facts.credits);
    setDialog({ reason: facts.credits > 0 ? 'short' : 'empty', needed: facts.needed ?? null, message: error.message });
    return true;
  }, []);
  const open = useCallback(() => setDialog({ reason: 'info' }), []);
  const close = useCallback(() => setDialog(null), []);

  const value = useMemo(
    () => (info ? { enabled: true, balance, unlimited: info.unlimited, pricing: info.pricing, upgradeUrl: info.upgradeUrl, update, handleError, open } : OFF),
    [info, balance, update, handleError, open],
  );
  return (
    <CreditsContext.Provider value={value}>
      {children}
      {info && <UpgradeDialog state={dialog} balance={balance} info={info} onClose={close} />}
    </CreditsContext.Provider>
  );
}
