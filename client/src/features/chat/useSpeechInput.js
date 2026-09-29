import { useCallback, useEffect, useRef, useState } from 'react';

const Recognition = typeof window === 'undefined' ? undefined : (window.SpeechRecognition ?? window.webkitSpeechRecognition);

const PROBLEMS = {
  'not-allowed': 'אין גישה למיקרופון. אפשרו אותה בהגדרות האתר בדפדפן ונסו שוב.',
  'service-not-allowed': 'הדפדפן חוסם זיהוי דיבור באתר הזה. אפשרו גישה למיקרופון בהגדרות האתר.',
  'audio-capture': 'לא נמצא מיקרופון. חברו מיקרופון ונסו שוב.',
  network: 'זיהוי הדיבור דורש חיבור לאינטרנט.',
  'language-not-supported': 'הדפדפן לא תומך בזיהוי דיבור בעברית.',
  'no-speech': 'לא נשמע דיבור. הקישו על המיקרופון ודברו.',
};

/**
 * Dictation into the prompt with the browser's own speech recognition (the Web
 * Speech API, in Chrome, Edge and Safari; Firefox has none, and then
 * `supported` is false). Chrome sends the audio to Google's recognition service.
 *
 * `onText(text)` receives everything heard since `start()`, final and interim
 * phrases together, each time it changes; `onError(message)` a Hebrew message.
 */
export function useSpeechInput({ lang = 'he-IL', onText, onError }) {
  const session = useRef(null);
  const handlers = useRef({ onText, onError });
  const [listening, setListening] = useState(false);
  useEffect(() => {
    handlers.current = { onText, onError };
  });

  const start = useCallback(() => {
    if (!Recognition || session.current) return;
    if (!window.isSecureContext) {
      handlers.current.onError?.('הקלטה קולית עובדת רק בכתובת מאובטחת (HTTPS) או ב-localhost.');
      return;
    }
    const recognition = new Recognition();
    recognition.lang = lang;
    recognition.interimResults = true;
    // Chrome on Android repeats earlier phrases in continuous mode, so there each tap takes one utterance.
    recognition.continuous = !/Android/i.test(navigator.userAgent);
    recognition.onresult = (event) => {
      const heard = Array.from(event.results, (result) => result[0].transcript.trim())
        .filter(Boolean)
        .join(' ');
      handlers.current.onText?.(heard);
    };
    recognition.onerror = (event) => {
      if (event.error !== 'aborted') handlers.current.onError?.(PROBLEMS[event.error] ?? 'זיהוי הדיבור נכשל. נסו שוב.');
    };
    recognition.onend = () => {
      if (session.current === recognition) session.current = null;
      setListening(false);
    };
    session.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      session.current = null;
      handlers.current.onError?.('לא ניתן להתחיל הקלטה כרגע. נסו שוב.');
    }
  }, [lang]);

  /** Stops listening; the last phrase still arrives. */
  const stop = useCallback(() => session.current?.stop(), []);

  /** Stops at once and drops what hasn't arrived yet (used when the prompt is sent). */
  const cancel = useCallback(() => {
    const recognition = session.current;
    session.current = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.abort();
    }
    setListening(false);
  }, []);

  useEffect(() => cancel, [cancel]);

  return { supported: Boolean(Recognition), listening, start, stop, cancel };
}
