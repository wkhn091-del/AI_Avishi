/** File categories by extension: label, icon and tint for the type glyph. */
import {
  File, FileArchive, FileAudio, FileCode2, FileImage, FileSpreadsheet, FileText, FileVideo, Package, Presentation,
} from 'lucide-react';

const TYPES = [
  { key: 'image', label: 'תמונה', icon: FileImage, color: '#0d9f8f', exts: 'png jpg jpeg gif webp avif bmp svg heic heif ico tif tiff psd' },
  { key: 'video', label: 'וידאו', icon: FileVideo, color: '#d04c88', exts: 'mp4 mov webm mkv avi m4v wmv' },
  { key: 'audio', label: 'שמע', icon: FileAudio, color: '#e0465a', exts: 'mp3 wav ogg flac m4a aac opus' },
  { key: 'document', label: 'מסמך', icon: FileText, color: '#2f74d0', exts: 'pdf doc docx odt rtf txt md epub pages tex' },
  { key: 'sheet', label: 'גיליון', icon: FileSpreadsheet, color: '#2e9a48', exts: 'xls xlsx xlsm ods numbers csv tsv' },
  { key: 'slides', label: 'מצגת', icon: Presentation, color: '#e4572e', exts: 'ppt pptx odp key' },
  { key: 'archive', label: 'ארכיון', icon: FileArchive, color: '#8b5cf6', exts: 'zip rar 7z tar gz tgz bz2 xz' },
  {
    key: 'code',
    label: 'קוד',
    icon: FileCode2,
    color: '#c99a0e',
    exts: 'js mjs cjs ts tsx jsx py json html css scss java kt c h cpp cs go rs php rb sh ps1 bat xml yml yaml toml sql swift dart lua gd ipynb',
  },
  { key: 'app', label: 'קובץ התקנה', icon: Package, color: '#5b6bbf', exts: 'exe msi dmg pkg apk aab ipa deb rpm appimage' },
];

const OTHER = { key: 'other', label: 'קובץ', icon: File, color: 'var(--color-graphite)' };

const BY_EXTENSION = new Map(TYPES.flatMap((type) => type.exts.split(' ').map((ext) => [ext, type])));

/** @param {string|null|undefined} extension without the dot, e.g. "pdf" */
export const fileTypeOf = (extension) => BY_EXTENSION.get(String(extension ?? '').toLowerCase()) ?? OTHER;

/** "report.final.PDF" → "pdf" */
export const extensionOf = (name) => {
  const match = /\.([^./\\]{1,12})$/.exec(name);
  return match ? match[1].toLowerCase() : '';
};
