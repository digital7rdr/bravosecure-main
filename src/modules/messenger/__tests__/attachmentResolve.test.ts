/**
 * Media-parity G4/M17 (2026-07-03) — attachment resolution fast-path,
 * single-flight, and error classification. The full download+decrypt
 * pipeline used to re-run on every bubble mount AND again in the viewer;
 * now a warm temp file resolves without touching bytes, concurrent
 * resolvers share ONE pipeline run, and failures carry a reason code so
 * the UI can say WHY ("no access" / "expired" / "offline") instead of an
 * opaque "Tap to retry".
 */

import {
  attachmentErrorText, classifyAttachmentError as classify,
  type AttachmentErrorReason,
} from '../media/attachmentError';
import {MediaHttpError} from '../media/mediaClient';

describe('attachmentErrorText (M17)', () => {
  const cases: Array<[AttachmentErrorReason | null, RegExp]> = [
    ['forbidden', /no access|resend/i],
    ['gone',      /expired|resend/i],
    ['offline',   /connection|retry/i],
    ['unavailable', /retry/i],
    [null,        /retry/i],
  ];
  it.each(cases)('reason %s → sensible copy', (reason, re) => {
    expect(attachmentErrorText(reason)).toMatch(re);
  });

  it('distinguishes forbidden from expired (different remediation)', () => {
    expect(attachmentErrorText('forbidden')).not.toBe(attachmentErrorText('gone'));
  });
});

describe('download-error classification', () => {
  it('403 → forbidden (no grant — ask sender to resend)', () => {
    expect(classify(new MediaHttpError(403, 'not_in_recipient_grant'))).toBe('forbidden');
  });
  it('404 → gone (object swept after 30d)', () => {
    expect(classify(new MediaHttpError(404, 'NoSuchKey'))).toBe('gone');
  });
  it('status 0 (network abort) → offline', () => {
    expect(classify(new MediaHttpError(0, 'download network failure'))).toBe('offline');
  });
  it('a plain network error message → offline', () => {
    expect(classify(new Error('Network request failed'))).toBe('offline');
    expect(classify(new Error('The operation was aborted'))).toBe('offline');
  });
  it('an unknown 500 → unavailable', () => {
    expect(classify(new MediaHttpError(500, 'boom'))).toBe('unavailable');
  });
});
