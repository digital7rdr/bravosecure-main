/**
 * The message body a shared news story produces.
 *
 * Kept in its OWN module, free of any React Native import, so it can be unit
 * tested directly. `ShareNewsSheet.tsx` imports ForwardList from ChatScreen,
 * which drags in native modules — a test that imported the builder from there
 * could not even parse.
 */
export interface ShareableNews {
  /** Headline shown above the link in the sent message. */
  title: string;
  /** Canonical article URL. Sharing is disabled when this is empty. */
  url: string;
  /** Optional publisher, appended as an attribution line. */
  source?: string;
}

export function buildShareText(item: ShareableNews): string {
  const lines = [item.title.trim()];
  if (item.source?.trim()) {
    // Bravo Intel's `src` arrives pre-formatted as "SOURCE: GUARDIAN"; the news
    // feed's `source` is bare ("Reuters"). Normalise so neither reads as
    // "via SOURCE: GUARDIAN".
    lines.push(`via ${item.source.replace(/^SOURCE:\s*/i, '').trim()}`);
  }
  lines.push(item.url.trim());
  return lines.filter(Boolean).join('\n');
}
