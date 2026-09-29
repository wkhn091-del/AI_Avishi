const longDate = new Intl.DateTimeFormat('he-IL', { dateStyle: 'long' });
const MEDIA_NOTES = { image: '_תמונה שנוצרה_', video: '_סרטון שנוצר_', music: '_מוזיקה שנוצרה_' };

/**
 * A conversation as Markdown, for sharing: the title, a line saying where and
 * when it's from, then every message under a heading, with the model that
 * answered. Attached files are listed by name; their content isn't included.
 */
export function conversationMarkdown(conversation) {
  const parts = [`# ${conversation.title || 'שיחה'}`, `שיחה מ-Stash, ${longDate.format(new Date(conversation.updatedAt ?? Date.now()))}.`];
  for (const message of conversation.messages ?? []) {
    if (message.role === 'user') {
      const names = (message.attachments ?? []).map((file) => file.name).filter(Boolean);
      parts.push(['## הודעה', message.content?.trim(), names.length ? `_קבצים מצורפים: ${names.join(', ')}_` : null].filter(Boolean).join('\n\n'));
    } else {
      const body = message.content?.trim() || (message.media ? (MEDIA_NOTES[message.media.kind] ?? '_קובץ מדיה שנוצר_') : '');
      parts.push([message.label ? `## תשובה (${message.label})` : '## תשובה', body].filter(Boolean).join('\n\n'));
    }
  }
  return `${parts.join('\n\n')}\n`;
}

/** A file name from a conversation title: no characters that file systems refuse, at most 80 of them. */
export const fileNameOf = (title) =>
  (title || 'שיחה')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'שיחה';

/** Saves text as a file through the browser's download. */
export function downloadText(name, text, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
