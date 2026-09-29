/**
 * Chat attachments: images and videos sent with a message. Images go to vision
 * models as Base64. Videos go to Gemini: inline up to GEMINI_INLINE_MAX_MB, and
 * larger ones through Gemini's Files API.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { uploadToGemini } from '../ai/geminiFiles.js';

export const IMAGE_TYPES = Object.freeze({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' });
export const VIDEO_TYPES = Object.freeze({
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/mpeg': '.mpeg', 'video/x-msvideo': '.avi', 'video/3gpp': '.3gp',
});
export const CHAT_MEDIA_TYPES = Object.freeze({ ...IMAGE_TYPES, ...VIDEO_TYPES });
export const kindOf = (mime) => (IMAGE_TYPES[mime] ? 'image' : VIDEO_TYPES[mime] ? 'video' : null);
export const attachmentPath = (record) => path.join(config.paths.attachments, record.file);
export const publicAttachment = (record) => ({
  id: record.id, name: record.name, mime: record.mime, kind: record.kind, size: record.size, url: `/api/chat/attachments/${record.id}`,
});

/** The attachments as the providers take them: Base64, or a Gemini file for a large video. */
export async function loadMedia(records, { onUpload } = {}) {
  const inlineLimit = config.chat.geminiInlineMaxMb * 1024 * 1024;
  const media = [];
  for (const record of records) {
    if (record.kind === 'video' && record.size > inlineLimit) {
      onUpload?.(record);
      const { fileUri, mime } = await uploadToGemini({ path: attachmentPath(record), mime: record.mime, name: record.name, size: record.size });
      media.push({ kind: 'video', mime, name: record.name, fileUri });
    } else {
      media.push({ kind: record.kind, mime: record.mime, name: record.name, data: (await fs.readFile(attachmentPath(record))).toString('base64') });
    }
  }
  return media;
}
