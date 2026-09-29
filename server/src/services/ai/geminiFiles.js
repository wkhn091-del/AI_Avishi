/**
 * Gemini's Files API, for videos too large to send inline: a resumable upload,
 * then polling until Gemini has processed the file and it can be used in a request.
 */
import fs from 'node:fs/promises';
import { AiError, keyFor } from './llmClient.js';

const BASE = 'https://generativelanguage.googleapis.com';
const POLL_MS = Number(process.env.GEMINI_FILE_POLL_MS) || 2_000;
const PROCESS_TIMEOUT_MS = 180_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failure = (message, log) => new AiError(message, { code: 'AI_UPLOAD_FAILED', log, provider: 'gemini' });

/** @returns {Promise<{ fileUri: string, mime: string }>} */
export async function uploadToGemini({ path, mime, name, size }) {
  const key = keyFor('gemini');
  if (!key) throw failure('וידאו נשלח רק ל-Gemini. הוסיפו GEMINI_API_KEY.', 'No Gemini key for a video upload.');
  const start = await fetch(`${BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: name } }),
  });
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!start.ok || !uploadUrl) throw failure('העלאת הווידאו ל-Gemini נכשלה.', `Gemini upload start: HTTP ${start.status}`);
  const done = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: await fs.readFile(path),
  });
  if (!done.ok) throw failure('העלאת הווידאו ל-Gemini נכשלה.', `Gemini upload: HTTP ${done.status}`);
  let file = (await done.json()).file;
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (file?.state === 'PROCESSING' && Date.now() < deadline) {
    await sleep(POLL_MS);
    const response = await fetch(`${BASE}/v1beta/${file.name}`, { headers: { 'x-goog-api-key': key } });
    if (!response.ok) throw failure('Gemini לא הצליח לעבד את הווידאו.', `Gemini file status: HTTP ${response.status}`);
    file = await response.json();
  }
  if (file?.state !== 'ACTIVE' || !file.uri) {
    throw failure('Gemini לא הצליח לעבד את הווידאו. נסו סרטון קצר יותר, או בפורמט MP4.', `Gemini file state: ${file?.state ?? 'unknown'}`);
  }
  return { fileUri: file.uri, mime: file.mimeType ?? mime };
}
