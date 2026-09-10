/**
 * B-662 — the chat-list preview showed "(encrypted)" instead of the latest
 * chat whenever the newest event was a call record or a delete-for-everyone
 * tombstone (both carry an empty body and previewOf had no branch for them).
 * These pins keep every empty-body message type mapped to a human label.
 */
import {lastMessagePreview} from '../conversationPreview';

describe('B-662 — lastMessagePreview', () => {
  it('renders a call record as a call, never "(encrypted)"', () => {
    expect(lastMessagePreview({type: 'call', content: ''})).toBe('📞 Call');
  });

  it('renders a delete-for-everyone tombstone as deleted, never "(encrypted)"', () => {
    expect(lastMessagePreview({type: 'text', content: '', deleted_for_all: true})).toBe('Message deleted');
  });

  it('tombstone wins over the media label — a deleted photo is not "📷 Photo"', () => {
    expect(lastMessagePreview({type: 'image', content: '', deleted_for_all: true})).toBe('Message deleted');
  });

  it('shows a system row body verbatim (decrypt-failure notice etc.)', () => {
    expect(lastMessagePreview({type: 'system', content: 'Ask the sender to resend it.'}))
      .toBe('Ask the sender to resend it.');
    expect(lastMessagePreview({type: 'system', content: ''})).toBe('Security update');
  });

  it('keeps the MSG-13 media labels', () => {
    expect(lastMessagePreview({type: 'file'})).toBe('📎 Attachment');
    expect(lastMessagePreview({type: 'image'})).toBe('📷 Photo');
    expect(lastMessagePreview({type: 'audio'})).toBe('🎤 Voice message');
    expect(lastMessagePreview({type: 'video'})).toBe('🎬 Video');
  });

  it('plain text shows its body; the "(encrypted)" fallback is text-only and last-resort', () => {
    expect(lastMessagePreview({type: 'text', content: 'hello'})).toBe('hello');
    expect(lastMessagePreview({type: 'text', content: ''})).toBe('(encrypted)');
  });

  it('no last message at all returns null — the caller owns empty-state copy', () => {
    expect(lastMessagePreview(undefined)).toBeNull();
    expect(lastMessagePreview(null)).toBeNull();
  });
});
