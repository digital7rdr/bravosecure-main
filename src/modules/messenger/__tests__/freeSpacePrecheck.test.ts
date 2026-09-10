/**
 * MD-08 — proactive free-space prechecks + CA-07 DND reliability row.
 *
 * The postures pinned here (both FAIL OPEN — a probe that cannot read its
 * signal must never block or nag):
 *  - media download: below-threshold disk throws NoFreeSpaceError BEFORE the
 *    network+decrypt spend; surfaces as the 'no_space' attachmentError.
 *  - restore start: WARN-ONLY (BACKUP_LOOP forbids new restore dead-end
 *    classes) — low disk paints the existing banner and the restore runs.
 *  - DND wrapper: missing native module reads as "not DND" (old APK / iOS),
 *    never as a prompt.
 */

jest.mock('react-native', () => ({
  Platform: {OS: 'android', select: (o: {android?: unknown; default?: unknown}) => o.android ?? o.default},
  NativeModules: {},
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {getItem: async () => null, setItem: async () => {}, removeItem: async () => {}},
}));

const mockFreeBytes = jest.fn<Promise<number>, []>();
// `readFreeBytes` probes BOTH expo-file-system entry points and fails open on
// a miss, so a mock that only covers the legacy one makes these assertions
// depend on which entry point resolves. When the legacy mock did not take
// effect the probe fell through to the empty `expo-file-system` stub, returned
// null, and every "must throw" test saw a silent resolve instead — a moving,
// order-dependent red that passed in isolation. Both paths now yield the same
// number, so the suite tests the THRESHOLD LOGIC (what it is for) rather than
// module resolution. Neither assertion is relaxed.
jest.mock('expo-file-system/legacy', () => ({
  getFreeDiskStorageAsync: () => mockFreeBytes(),
}), {virtual: true});
jest.mock('expo-file-system', () => ({
  getFreeDiskStorageAsync: () => mockFreeBytes(),
}), {virtual: true});

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  assertFreeSpaceFor,
  lowSpaceWarning,
  NoFreeSpaceError,
  FREE_SPACE_HEADROOM_BYTES,
} from '../media/freeSpace';
import {classifyAttachmentError, attachmentErrorText} from '../media/attachmentError';
import {isDndEnabled} from '../push/batteryOptimization';

const MB = 1024 * 1024;

beforeEach(() => { mockFreeBytes.mockReset(); });

describe('MD-08 — assertFreeSpaceFor (media download)', () => {
  it('throws NoFreeSpaceError when the disk cannot hold size + headroom', async () => {
    mockFreeBytes.mockResolvedValue(60 * MB);
    await expect(assertFreeSpaceFor(20 * MB)).rejects.toBeInstanceOf(NoFreeSpaceError);
  });

  it('resolves when there is room', async () => {
    mockFreeBytes.mockResolvedValue(500 * MB);
    await expect(assertFreeSpaceFor(20 * MB)).resolves.toBeUndefined();
  });

  it('unknown size still guards a near-full disk (headroom-only)', async () => {
    mockFreeBytes.mockResolvedValue(FREE_SPACE_HEADROOM_BYTES - 1);
    await expect(assertFreeSpaceFor(undefined)).rejects.toBeInstanceOf(NoFreeSpaceError);
  });

  it('FAIL OPEN: a probe failure never blocks the download', async () => {
    mockFreeBytes.mockRejectedValue(new Error('fs probe broke'));
    await expect(assertFreeSpaceFor(20 * MB)).resolves.toBeUndefined();
  });

  it('the error message carries numbers only — no filename, no key material', () => {
    const e = new NoFreeSpaceError(70 * MB, 10 * MB);
    expect(e.message).toMatch(/^insufficient_storage need=\d+ free=\d+$/);
  });
});

describe('MD-08 — the no_space attachment reason', () => {
  it('classifies the precheck error and the reactive ENOSPC class', () => {
    expect(classifyAttachmentError(new NoFreeSpaceError(1, 0))).toBe('no_space');
    expect(classifyAttachmentError(new Error('ENOSPC: no space left on device'))).toBe('no_space');
  });

  it('has its own copy — never the generic "Tap to retry" (a retry cannot fix a full disk)', () => {
    expect(attachmentErrorText('no_space')).toBe('Not enough storage — free up space');
  });

  it('the download path probes BEFORE downloadMedia (source scan; CRLF-safe)', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'media', 'useAttachmentUri.ts'), 'utf8',
    );
    const probe = src.indexOf('await assertFreeSpaceFor(');
    const download = src.indexOf('rt.downloadMedia({');
    expect(probe).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(probe);
  });
});

describe('MD-08 — restore start is WARN-ONLY', () => {
  it('lowSpaceWarning reports low disk, stays silent otherwise, fails open', async () => {
    mockFreeBytes.mockResolvedValue(10 * MB);
    expect(await lowSpaceWarning()).toBe(10 * MB);
    mockFreeBytes.mockResolvedValue(5000 * MB);
    expect(await lowSpaceWarning()).toBeNull();
    mockFreeBytes.mockRejectedValue(new Error('probe broke'));
    expect(await lowSpaceWarning()).toBeNull();
  });

  it('restoreAllMessages warns through the existing surface and PROCEEDS (source scan)', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'backup', 'restoreMessages.ts'), 'utf8',
    );
    const at = src.indexOf('await lowSpaceWarning()');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 400);
    expect(block).toContain('setError(');
    // The probe block must not abort the restore — no return/throw between
    // the warning and the conversations fetch.
    const untilFetch = src.slice(at, src.indexOf("emit({step: 'conversations'", at));
    expect(untilFetch).not.toMatch(/^\s{2}return\b/m);
    expect(untilFetch).not.toContain('throw new');
  });
});

describe('CA-07 — DND reliability row', () => {
  it('wrapper degrades safely: no native module reads as "not DND"', async () => {
    await expect(isDndEnabled()).resolves.toBe(false);
  });

  it('the card consults DND and offers the settings deep link (source scan)', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'components', 'NotificationReliabilityCard.tsx'), 'utf8',
    );
    expect(src).toContain('isDndEnabled(),');
    expect(src).toContain('openDndSettings()');
    expect(src).toContain('Do Not Disturb is on');
  });
});
