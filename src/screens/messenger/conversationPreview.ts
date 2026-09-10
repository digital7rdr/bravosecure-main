/**
 * B-662 — the ONE rule for a conversation row's preview line.
 *
 * `previewOf` (MessengerHomeScreen) and the Groups list each hand-rolled this
 * and both had the same hole: `type: 'call'` history rows and
 * delete-for-everyone tombstones carry an EMPTY body, so they fell through
 * `content || '(encrypted)'` and the row read "(encrypted)" instead of the
 * latest chat. That is unfixed MSG-13 residue — the audio/video half was
 * patched 2026-07, the call/tombstone half never was.
 *
 * Returns null when there is no last message at all — each caller owns its
 * own empty-state copy ("start chatting" vs "tap to start").
 */

interface PreviewableMessage {
  type?: string;
  content?: string | null;
  deleted_for_all?: boolean;
}

export function lastMessagePreview(last: PreviewableMessage | undefined | null): string | null {
  if (!last) {return null;}
  // Tombstone FIRST — a deleted image is "Message deleted", not "📷 Photo".
  if (last.deleted_for_all) {return 'Message deleted';}
  if (last.type === 'file')  {return '📎 Attachment';}
  if (last.type === 'image') {return '📷 Photo';}
  if (last.type === 'audio') {return '🎤 Voice message';}
  if (last.type === 'video') {return '🎬 Video';}
  if (last.type === 'call')  {return '📞 Call';}
  // System rows carry a human-readable body already (decrypt-failure notice,
  // group membership changes); show it rather than pretending it's ciphertext.
  if (last.type === 'system') {return last.content || 'Security update';}
  return last.content || '(encrypted)';
}
