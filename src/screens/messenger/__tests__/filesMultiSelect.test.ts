/**
 * Files-tab multi-select (move / share / delete) — behavioural tests for the
 * pure decision layer the screen wires its effects into. No RN mounting.
 */
import {
  toggleSelected,
  selectAllVisible,
  runBatchVaultMove,
  runBatchShare,
  runBatchDelete,
  type SelectableFile,
} from '../filesMultiSelect';

const file = (id: string, over: Partial<SelectableFile> = {}): SelectableFile => ({
  id,
  conversationId: 'c1',
  name:           `file-${id}`,
  mimeType:       'image/jpeg',
  inVault:        false,
  ...over,
});

describe('selection state', () => {
  it('toggles ids in and out', () => {
    const one = toggleSelected(new Set(), 'a');
    expect([...one!]).toEqual(['a']);
    const two = toggleSelected(one!, 'b');
    expect(two!.has('a') && two!.has('b')).toBe(true);
    const back = toggleSelected(two!, 'b');
    expect([...back!]).toEqual(['a']);
  });

  it('returns null when the last selection is removed (exit selection mode)', () => {
    expect(toggleSelected(new Set(['a']), 'a')).toBeNull();
  });

  it('does not mutate the input set', () => {
    const input = new Set(['a']);
    toggleSelected(input, 'b');
    expect([...input]).toEqual(['a']);
  });

  it('select-all unions the visible ids into the selection', () => {
    const out = selectAllVisible(new Set(['x']), ['a', 'b']);
    expect(out!.size).toBe(3);
  });

  it('select-all when everything visible is already selected means deselect (null)', () => {
    expect(selectAllVisible(new Set(['a', 'b']), ['a', 'b'])).toBeNull();
  });
});

describe('runBatchVaultMove', () => {
  const bytes = new Uint8Array([1]);

  it('moves each non-vaulted file with the msg:<id> sourceKey and skips vaulted rows', async () => {
    const calls: string[] = [];
    const out = await runBatchVaultMove(
      [file('a'), file('b', {inVault: true}), file('c', {mimeType: ''})],
      {
        resolveBytes: async () => bytes,
        moveToVault:  async p => { calls.push(`${p.sourceKey}|${p.mimeType}`); return {ok: true}; },
      },
    );
    expect(calls).toEqual(['msg:a|image/jpeg', 'msg:c|application/octet-stream']);
    expect(out).toEqual({moved: 2, alreadyInVault: 1, failed: [], fatal: null, fatalReason: null, cancelled: false});
  });

  it('collects per-file failures (no bytes / resolve throw / transfer_failed) and continues', async () => {
    const out = await runBatchVaultMove(
      [file('a'), file('b'), file('c'), file('d')],
      {
        resolveBytes: async f => {
          if (f.id === 'a') {return null;}
          if (f.id === 'b') {throw new Error('read failed');}
          return bytes;
        },
        moveToVault: async p =>
          p.sourceKey === 'msg:c'
            ? {ok: false, reason: 'transfer_failed', message: 'boom'}
            : {ok: true},
      },
    );
    expect(out.failed).toEqual(['file-a', 'file-b', 'file-c']);
    expect(out.moved).toBe(1);
    expect(out.fatal).toBeNull();
  });

  it('a user cancel aborts the REST of the batch', async () => {
    const attempted: string[] = [];
    const out = await runBatchVaultMove(
      [file('a'), file('b'), file('c')],
      {
        resolveBytes: async () => bytes,
        moveToVault:  async p => {
          attempted.push(p.sourceKey);
          return p.sourceKey === 'msg:b'
            ? {ok: false, reason: 'cancelled', message: 'Vault move cancelled.'}
            : {ok: true};
        },
      },
    );
    expect(attempted).toEqual(['msg:a', 'msg:b']);
    expect(out).toMatchObject({moved: 1, cancelled: true, fatal: null, failed: []});
  });

  it('no_pin / mfa_unavailable is batch-fatal: one honest message, remaining skipped', async () => {
    const attempted: string[] = [];
    const out = await runBatchVaultMove(
      [file('a'), file('b')],
      {
        resolveBytes: async () => bytes,
        moveToVault:  async p => {
          attempted.push(p.sourceKey);
          return {ok: false, reason: 'no_pin', message: 'Set up your File Vault PIN first.'};
        },
      },
    );
    expect(attempted).toEqual(['msg:a']);
    expect(out.fatal).toBe('Set up your File Vault PIN first.');
    expect(out.fatalReason).toBe('no_pin');
    expect(out.moved).toBe(0);
  });

  /**
   * B-591 — a LAPSED PLAN is batch-fatal too, and it must be nameable.
   *
   * The bug: `tier` fell through to the per-file `failed` bucket, so a
   * lapsed-Pro user selecting 20 files got 20 biometric ceremonies and 20
   * server round-trips, ending in a bare list of filenames that never said
   * why. It fails every file identically, which is this function's own stated
   * rule for aborting — and `fatalReason` exists so the caller can show the
   * upgrade prompt instead of quoting a security-sounding message.
   */
  it('B-591: tier is batch-fatal and NAMED, so the caller can offer the plans screen', async () => {
    const attempted: string[] = [];
    const out = await runBatchVaultMove(
      [file('a'), file('b'), file('c')],
      {
        resolveBytes: async () => bytes,
        moveToVault:  async p => {
          attempted.push(p.sourceKey);
          return {ok: false, reason: 'tier', message: 'Secure Cloud Vault needs an active Pro plan.'};
        },
      },
    );
    // ONE ceremony, not three.
    expect(attempted).toEqual(['msg:a']);
    expect(out.fatalReason).toBe('tier');
    expect(out.moved).toBe(0);
    // NOT the per-file bucket — that is what discarded the reason before.
    expect(out.failed).toEqual([]);
  });
});

describe('runBatchShare', () => {
  it('shares sequentially and reports files with no resolvable uri', async () => {
    const shared: string[] = [];
    const out = await runBatchShare(
      [file('a'), file('b'), file('c')],
      {
        resolveUri: async f => (f.id === 'b' ? null : `file:///${f.id}`),
        share:      async uri => { shared.push(uri); },
      },
    );
    expect(shared).toEqual(['file:///a', 'file:///c']);
    expect(out).toEqual({shared: 2, failed: ['file-b']});
  });

  it('a share() throw is a per-file failure, not an abort', async () => {
    const out = await runBatchShare(
      [file('a'), file('b')],
      {
        resolveUri: async f => `file:///${f.id}`,
        share:      async uri => { if (uri === 'file:///a') {throw new Error('no target');} },
      },
    );
    expect(out).toEqual({shared: 1, failed: ['file-a']});
  });
});

describe('runBatchDelete', () => {
  it('removes the vault row when one exists AND the chat message, for every file', () => {
    const removedMsgs: string[] = [];
    const removedVault: string[] = [];
    const n = runBatchDelete(
      [file('a'), file('b', {conversationId: 'c2'})],
      {
        removeMessage:     (conv, id) => { removedMsgs.push(`${conv}/${id}`); },
        vaultObjectKeyFor: f => (f.id === 'a' ? 'obj-a' : null),
        removeVaultRow:    key => { removedVault.push(key); },
      },
    );
    expect(n).toBe(2);
    expect(removedMsgs).toEqual(['c1/a', 'c2/b']);
    expect(removedVault).toEqual(['obj-a']);
  });
});
