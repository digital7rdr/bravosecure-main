import {sendErrorText, SESSION_REESTABLISH_TEXT, RUNTIME_WARMING_TEXT} from '../sendErrorText';

describe('B-272 — internal engineering strings must never reach the banner', () => {
  it('the exact string the founder saw maps to human copy', () => {
    // Screenshotted in a chat: "production runtime requires
    // configureMessengerRuntime(cfg) first".
    const e = new Error('production runtime requires configureMessengerRuntime(cfg) first');
    expect(sendErrorText(e, 'Send failed')).toBe(RUNTIME_WARMING_TEXT);
  });

  it('any message naming a function call falls back rather than leaking', () => {
    // This file was allow-by-default: anything unrecognised went to the user
    // verbatim. That is how the one above escaped, so close the CLASS.
    for (const msg of [
      'buildProductionRuntime() failed',
      'Cannot read property foo of undefined in resolveOwnStore()',
      'installIdentity(store) threw',
    ]) {
      expect(sendErrorText(new Error(msg), 'Send failed')).toBe('Send failed');
    }
  });

  it('deliberate user-facing copy with a parenthetical still passes through', () => {
    // The guard must not eat real product copy — note the SPACE before "(".
    const msg = 'group too large to send (300 > 250 recipients)';
    expect(sendErrorText(new Error(msg), 'Send failed')).toBe(msg);
  });
});

describe('sendErrorText (B-74) — user-facing send-error banner text', () => {
  it('maps the raw libsignal "No record for <address>" to the session message', () => {
    const e = new Error('No record for 3165d0e1-0d3f-4d8c-be5d-a4b85d11b453.1');
    expect(sendErrorText(e, 'Send failed')).toBe(SESSION_REESTABLISH_TEXT);
  });

  it('maps other session/crypto-internal errors to the session message', () => {
    for (const msg of [
      'NoSessionError: no session for peer',
      'Bad MAC',
      'Invalid key length',
      'Untrusted identity key for conversation',
    ]) {
      expect(sendErrorText(new Error(msg), 'Send failed')).toBe(SESSION_REESTABLISH_TEXT);
    }
  });

  it('passes deliberately user-readable pipeline errors through', () => {
    const e = new Error('group too large to send (300 > 250 recipients)');
    expect(sendErrorText(e, 'Send failed')).toBe('group too large to send (300 > 250 recipients)');
  });

  it('GF-5 — passes the pending-group-key copy through unmodified', () => {
    const msg = 'Waiting for this group’s encryption key — the message will send once the key syncs.';
    expect(sendErrorText(new Error(msg), 'Send failed')).toBe(msg);
  });

  it('redacts a bare uuid/address inside a pass-through message', () => {
    const e = new Error('relay rejected envelope for c700ccde-0e7a-4d4c-b644-076524be9b81.1');
    expect(sendErrorText(e, 'Send failed')).toBe('relay rejected envelope for contact');
  });

  it('falls back for non-Error throws and empty messages', () => {
    expect(sendErrorText('boom', 'Retry failed')).toBe('Retry failed');
    expect(sendErrorText(new Error(''), 'Media send failed')).toBe('Media send failed');
    expect(sendErrorText(undefined, 'Send failed')).toBe('Send failed');
  });
});
