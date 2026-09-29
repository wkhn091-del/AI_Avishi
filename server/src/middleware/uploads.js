/**
 * Multer upload middleware for the two upload endpoints.
 *
 * - Files stream straight to disk under server-generated names (UUID + safe
 *   extension), so client filenames never touch the filesystem.
 * - `defParamCharset: 'utf8'` keeps non-Latin filenames (Hebrew, emoji, …)
 *   intact; multer's default of latin1 would turn them into mojibake.
 * - Multer errors are translated into HttpErrors with messages a person can act on.
 */
import { isolate } from '../lib/bidi.js';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { config } from '../config.js';
import { HttpError } from '../lib/httpError.js';
import { safeExtension } from '../lib/filenames.js';
import { CHAT_MEDIA_TYPES } from '../services/chat/attachments.js';

const MB = 1024 * 1024;

function storageIn(directory, extensionFor) {
  return multer.diskStorage({
    destination: directory,
    filename: (req, file, callback) => callback(null, `${randomUUID()}${extensionFor(file)}`),
  });
}

function withReadableErrors(middleware, { maxBytes, noun }) {
  return (req, res, next) =>
    middleware(req, res, (error) => {
      if (!error || !(error instanceof multer.MulterError)) return next(error);
      switch (error.code) {
        case 'LIMIT_FILE_SIZE':
          return next(new HttpError(413, `${noun} גדול מהמגבלה של ${isolate(`${Math.round(maxBytes / MB)} MB`)}.`, 'FILE_TOO_LARGE'));
        case 'LIMIT_FILE_COUNT':
          return next(new HttpError(400, `אפשר להעלות עד ${config.limits.filesPerUpload} קבצים בכל פעם.`, 'TOO_MANY_FILES'));
        case 'LIMIT_UNEXPECTED_FILE':
          return next(new HttpError(400, `שדה העלאה לא צפוי: ${isolate(error.field)}.`, 'UNEXPECTED_FIELD'));
        default:
          return next(new HttpError(400, `ההעלאה נכשלה (${error.code}).`, error.code));
      }
    });
}

/** Single `.zip` in the multipart field `archive`. Content is verified later by the scanner. */
export const acceptArchive = withReadableErrors(
  multer({
    storage: storageIn(config.paths.archives, () => '.zip'),
    defParamCharset: 'utf8',
    limits: { fileSize: config.limits.archiveBytes, files: 1, fields: 10 },
    fileFilter(req, file, callback) {
      if (file.originalname.toLowerCase().endsWith('.zip')) return callback(null, true);
      callback(new HttpError(415, 'אפשר להוסיף כפרויקט רק קובצי ZIP.', 'UNSUPPORTED_TYPE'));
    },
  }).single('archive'),
  { maxBytes: config.limits.archiveBytes, noun: 'הארכיון' },
);

/** Up to `filesPerUpload` files of any type in the multipart field `files`. */
export const acceptFiles = withReadableErrors(
  multer({
    storage: storageIn(config.paths.files, (file) => safeExtension(file.originalname)),
    defParamCharset: 'utf8',
    limits: { fileSize: config.limits.fileBytes, files: config.limits.filesPerUpload, fields: 10 },
  }).array('files', config.limits.filesPerUpload),
  { maxBytes: config.limits.fileBytes, noun: 'הקובץ' },
);

/** One image or video for the chat. The per-kind limits (image vs video) are checked by the route. */
const chatMediaBytes = Math.max(config.chat.imageMaxMb, config.chat.videoMaxMb) * MB;
export const acceptChatMedia = withReadableErrors(
  multer({
    storage: storageIn(config.paths.attachments, (file) => CHAT_MEDIA_TYPES[file.mimetype] ?? ''),
    defParamCharset: 'utf8',
    limits: { fileSize: chatMediaBytes, files: 1, fields: 5 },
    fileFilter(req, file, callback) {
      if (CHAT_MEDIA_TYPES[file.mimetype]) return callback(null, true);
      callback(new HttpError(415, 'אפשר לצרף תמונה (PNG, JPEG, WebP, GIF) או וידאו (MP4, WebM, MOV, MPEG, AVI, 3GP).', 'UNSUPPORTED_MEDIA'));
    },
  }).single('file'),
  { maxBytes: chatMediaBytes, noun: 'הקובץ' },
);
