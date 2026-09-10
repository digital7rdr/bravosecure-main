import {ConfigService} from '@nestjs/config';
import {InternalServerErrorException} from '@nestjs/common';
import {createHmac} from 'node:crypto';
import {TurnService} from './turn.service';

const SECRET = 'test-turn-secret-long-enough-for-hmac';

function svc(overrides: Record<string, unknown> = {}) {
  const cfg: Partial<ConfigService> = {
    get: (k: string): unknown => ({
      'turn.staticAuthSecret': SECRET,
      'turn.ttlSeconds':       3600,
      'turn.urls':             ['turn:a.example.com:3478?transport=udp'],
      'turn.stunUrls':         [],
      ...overrides,
    }[k] as unknown),
  };
  return new TurnService(cfg as ConfigService);
}

describe('TurnService — coturn REST credentials', () => {
  it('returns username in `${exp}:${opaqueId}` form with matching HMAC-SHA1 credential', () => {
    const before = Math.floor(Date.now() / 1000);
    const s = svc();
    const {username, credential, urls, expiresAt} = s.issueCredentials('alice');

    // username shape
    const [ts, opaqueId] = username.split(':');
    expect(Number.parseInt(ts, 10)).toBe(expiresAt);
    // Audit P1-C8 — the second segment MUST NOT be the callerUserId.
    // It's a 16-byte random hex id so coturn's access log can't be
    // turned into a who-called-whom oracle.
    expect(opaqueId).not.toBe('alice');
    expect(opaqueId).toMatch(/^[0-9a-f]{32}$/);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600);

    // HMAC correctness — compute independently and compare.
    const expected = createHmac('sha1', SECRET).update(username).digest('base64');
    expect(credential).toBe(expected);

    expect(urls).toEqual(['turn:a.example.com:3478?transport=udp']);
  });

  it('mints a fresh opaque id per call (no userId reuse across credentials)', () => {
    const s = svc();
    const a = s.issueCredentials('alice');
    const b = s.issueCredentials('alice');
    // Same caller, different opaque ids — colocated coturn log entries
    // cannot be linked back to the same userId without the messenger-
    // service attribution log.
    expect(a.username.split(':')[1]).not.toBe(b.username.split(':')[1]);
  });

  it('never embeds the raw caller userId in the username', () => {
    const s = svc();
    const {username} = s.issueCredentials('alice:with:colons and spaces');
    // Audit P1-C8 — the previous implementation replaced unsafe chars
    // with `_`. The opaque-id implementation never references the
    // userId at all on the wire.
    expect(username).not.toMatch(/alice/);
  });

  it('fails when the shared secret is not configured', () => {
    const s = svc({'turn.staticAuthSecret': ''});
    expect(() => s.issueCredentials('alice')).toThrow(InternalServerErrorException);
  });

  it('fails when no TURN URLs are configured', () => {
    const s = svc({'turn.urls': []});
    expect(() => s.issueCredentials('alice')).toThrow(InternalServerErrorException);
  });

  it('prepends STUN URLs to the response so clients gather srflx without auth', () => {
    const s = svc({
      'turn.urls':     ['turn:relay.example.com:3478?transport=udp'],
      'turn.stunUrls': ['stun:stun.l.google.com:19302'],
    });
    const {urls} = s.issueCredentials('alice');
    // STUN first (no auth needed, fast gather), TURN after (needs the
    // username/credential pair we returned alongside).
    expect(urls).toEqual([
      'stun:stun.l.google.com:19302',
      'turn:relay.example.com:3478?transport=udp',
    ]);
  });
});
