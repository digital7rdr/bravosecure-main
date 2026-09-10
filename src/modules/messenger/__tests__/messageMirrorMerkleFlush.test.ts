/**
 * B-45 round 3 â€” the mirror force-flushed ROWS on AppState background but
 * abandoned the pending Merkle-commit timer, so the server routinely held
 * more rows than the last signed count and every later restore hard-failed
 * `rows_count_mismatch`. These tests pin the two new behaviours:
 *
 *   1. Backgrounding fires the pending commit hook (fireMerkleHookNow via
 *      the AppState handler) right after the forced flushes.
 *   2. drainMirrorOutbox() pushes every queued row synchronously â€” used by
 *      BackupSetupScreen so the baseline commit signs the UPLOADED set,
 *      not the pre-flush server state.
 */
import type {LocalMessage} from '../store/types';

jest.mock('react-native', () => {
  const listeners: Array<(s: string) => void> = [];
  return {
    __esModule: true,
    AppState: {
      addEventListener: jest.fn((_evt: string, cb: (s: string) => void) => {
        listeners.push(cb);
        return {remove: () => { const i = listeners.indexOf(cb); if (i >= 0) {listeners.splice(i, 1);} }};
      }),
      // test helper â€” fire all registered handlers
      __emit: (s: string) => { for (const cb of [...listeners]) {cb(s);} },
    },
  };
});

const mockPutMessages = jest.fn(async (rows: unknown[]) => ({written: (rows as unknown[]).length}));
jest.mock('../backup/backupClient', () => {
  class BackupError extends Error {
    kind: string;
    constructor(kind: string, message: string) { super(message); this.name = 'BackupError'; this.kind = kind; }
  }
  return {
    __esModule: true,
    BackupError,
    backupClient: {
      putMessages: (rows: unknown[]) => mockPutMessages(rows),
      putConversations: jest.fn(async () => ({written: 0})),
    },
  };
});

import {AppState} from 'react-native';
import {
  setMirrorKey, setMirrorOwner, mirrorMessage, disposeMirror,
  setMerkleAfterFlushHook, fireMerkleHookNow, drainMirrorOutbox,
} from '../backup/messageMirror';

const OWNER = 'owner-1';

function msg(id: string): LocalMessage {
  return {
    id,
    conversation_id: 'conv-1',
    sender_id: OWNER,
    content: `hello ${id}`,
    type: 'text',
    status: 'sent',
    created_at: new Date(1_700_000_000_000).toISOString(),
  } as unknown as LocalMessage;
}

async function makeKey(): Promise<CryptoKey> {
  return (globalThis.crypto as Crypto).subtle.importKey(
    'raw', new Uint8Array(32).fill(1), {name: 'AES-GCM'}, false, ['encrypt', 'decrypt'],
  );
}

const tick = (ms = 25): Promise<void> => new Promise(r => setTimeout(r, ms));

describe('B-45 R3 â€” mirror commit lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    disposeMirror();
  });
  afterEach(() => {
    setMerkleAfterFlushHook(null);
    disposeMirror();
  });

  it('drainMirrorOutbox ships every queued row without waiting for the debounce', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    mirrorMessage(OWNER, msg('m1'));
    mirrorMessage(OWNER, msg('m2'));
    expect(mockPutMessages).not.toHaveBeenCalled();   // still queued (1.5s debounce)
    await drainMirrorOutbox();
    expect(mockPutMessages).toHaveBeenCalledTimes(1);
    expect((mockPutMessages.mock.calls[0][0] as unknown[]).length).toBe(2);
  });

  it('fireMerkleHookNow invokes the hook and clears the pending debounce', async () => {
    const hook = jest.fn(async () => undefined);
    setMerkleAfterFlushHook(hook);
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    mirrorMessage(OWNER, msg('m3'));
    await drainMirrorOutbox();                    // flush schedules the (5s) commit timer
    expect(hook).not.toHaveBeenCalled();
    await fireMerkleHookNow();
    expect(hook).toHaveBeenCalledTimes(1);
    // Timer was cleared â€” no second (debounced) invocation later.
    await tick(50);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('backgrounding flushes the queue AND ships the pending commit', async () => {
    const hook = jest.fn(async () => undefined);
    setMerkleAfterFlushHook(hook);
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());                // installs the AppState handler
    mirrorMessage(OWNER, msg('m4'));
    expect(mockPutMessages).not.toHaveBeenCalled();

    (AppState as unknown as {__emit: (s: string) => void}).__emit('background');
    await tick(50);                               // let the async handler run

    expect(mockPutMessages).toHaveBeenCalledTimes(1); // rows force-flushed (existing behaviour)
    expect(hook).toHaveBeenCalledTimes(1);        // NEW: commit shipped too, not abandoned
  });

  it('backgrounding with nothing pending does not commit (no gratuitous network)', async () => {
    const hook = jest.fn(async () => undefined);
    setMerkleAfterFlushHook(hook);
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    (AppState as unknown as {__emit: (s: string) => void}).__emit('background');
    await tick(50);
    expect(mockPutMessages).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });
});
