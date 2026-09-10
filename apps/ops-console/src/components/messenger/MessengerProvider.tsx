'use client';

/**
 * Singleton React context that owns the encrypted messenger runtime
 * for the whole ops-console session. Mounts inside the root layout so
 * any page can request unlock + listen to incoming envelopes.
 *
 * State machine:
 *   absent  — no admin user known yet (still loading /ops/me)
 *   locked  — runtime not booted; UI shows VaultUnlockModal on demand
 *   unlocking — passphrase being verified
 *   unlocked  — runtime is pumping envelopes; panels can subscribe
 *   error     — boot failed; show message + retry
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import {MessengerRuntime, type DecryptedMessage, type PresenceState} from '@/lib/messenger/runtime';
import {WrongPassphraseError} from '@/lib/messenger/errors';
import {useOpsMe} from '@/lib/api';
import {VaultUnlockModal} from './VaultUnlockModal';

type State = 'absent' | 'locked' | 'unlocking' | 'unlocked' | 'error';

interface Ctx {
  state: State;
  error: string | null;
  userId: string | null;
  /** Live runtime. Null until state === 'unlocked'. */
  runtime: MessengerRuntime | null;
  /** Open the unlock dialog. Resolves when state becomes 'unlocked'. */
  requestUnlock: () => void;
  /** Forget the current key + close DB. UI snaps back to 'locked'. */
  lock: () => Promise<void>;
  /**
   * Audit P0-W5 — destructive sign-out: wipe IndexedDB vault for the
   * current admin. Used by `Shell.tsx` logout flow so a sign-out clears
   * every encrypted artefact for the previous admin's session before
   * the next admin authenticates in the same browser. The passphrase
   * canary, ratchet state, message history, and presence cache all go.
   */
  wipe: () => Promise<void>;
}

const MessengerCtx = createContext<Ctx | null>(null);

export function MessengerProvider({children}: {children: ReactNode}) {
  const {data: me} = useOpsMe();
  const userId = me?.admin.user_id ?? null;

  const [state, setState] = useState<State>('absent');
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const runtimeRef = useRef<MessengerRuntime | null>(null);

  useEffect(() => {
    if (!userId) { setState('absent'); return; }
    if (state === 'absent') setState('locked');
  }, [userId, state]);

  const unlock = useCallback(async (passphrase: string) => {
    if (!userId) throw new Error('no admin user yet');
    setState('unlocking'); setError(null);
    try {
      const runtime = await MessengerRuntime.unlock(userId, passphrase);
      await runtime.ensureIdentityPublished();
      runtime.startListening();
      // Session-level presence: while ops has the vault unlocked we are
      // reachable on the messenger, so flag ourselves as active to
      // anyone watching. Without this, mobile members only saw ops as
      // 'active' during the brief window when MissionGroupDock was open
      // — meaning the agent's chat list and chat header never lit up
      // green for the dispatcher.
      runtime.setActivity('active');
      runtimeRef.current = runtime;
      setState('unlocked');
      setModalOpen(false);
    } catch (e) {
      if (e instanceof WrongPassphraseError) setError('Wrong passphrase.');
      else setError((e as Error).message || 'Unlock failed');
      setState('locked');
      throw e;
    }
  }, [userId]);

  const lock = useCallback(async () => {
    // Flip back to away before the socket closes so watchers see the
    // transition cleanly. The disconnect handler will follow it up
    // with 'offline' on the last-socket close.
    runtimeRef.current?.setActivity('away');
    // Audit OPS-MSG-09 — close() stops the pumps, closes the IDB handle,
    // and drops the in-memory group-key cache (not just stopListening()).
    runtimeRef.current?.close();
    runtimeRef.current = null;
    setState('locked');
  }, []);

  /**
   * Audit P0-W5 — destructive sign-out. Closes the runtime, then
   * deletes the IndexedDB messenger database for the current admin
   * AND scrubs any sessionStorage / localStorage keys we control. The
   * passphrase canary, vault wrap-key salt, ratchet state, message
   * history, presence cache, and read-receipt cache are all gone after
   * this. A different admin signing in on the same browser starts
   * from a true clean slate.
   *
   * Idempotent — calling on an already-locked / never-unlocked runtime
   * just runs the IDB delete + storage scrub.
   */
  const wipe = useCallback(async () => {
    // Drop the live runtime + WS first so an in-flight session can't
    // race a wipe and re-create rows after the IDB delete starts.
    try {
      runtimeRef.current?.setActivity('away');
      runtimeRef.current?.stopListening();
      if (runtimeRef.current) {
        await runtimeRef.current.wipe();
      }
    } catch { /* runtime.wipe handles its own errors; never block sign-out */ }
    runtimeRef.current = null;

    // Even if no runtime was live, the IDB may exist from a prior
    // session: delete it by deterministic name. Indexed by userId so
    // we don't wipe a different admin's vault from this browser.
    if (typeof indexedDB !== 'undefined' && userId) {
      try {
        await new Promise<void>((res, rej) => {
          const req = indexedDB.deleteDatabase(`bravo-messenger-${userId}`);
          req.onsuccess = () => res();
          req.onerror   = () => rej(req.error);
          req.onblocked = () => res();
        });
      } catch { /* non-fatal — sign-out proceeds either way */ }
    }

    // Scrub any sessionStorage breadcrumbs the messenger surface
    // wrote. The httpOnly auth cookies are wiped server-side by
    // clearSession() in api.ts; this only touches values JS owns.
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.removeItem('bravo_ops_access_expires_at');
        window.sessionStorage.removeItem('bravo_ops_idle_logout');
      } catch { /* private-mode storage quirks — non-fatal */ }
    }

    setState('locked');
  }, [userId]);

  const requestUnlock = useCallback(() => { setModalOpen(true); }, []);

  const value: Ctx = useMemo(() => ({
    state, error, userId,
    runtime: runtimeRef.current,
    requestUnlock, lock, wipe,
  }), [state, error, userId, requestUnlock, lock, wipe]);

  // Tear down the runtime on unmount. Mirror the lock() cleanup so the
  // last 'away' frame goes out before we close the socket.
  useEffect(() => () => {
    runtimeRef.current?.setActivity('away');
    runtimeRef.current?.close();
  }, []);

  return (
    <MessengerCtx.Provider value={value}>
      {children}
      {modalOpen && (
        <VaultUnlockModal
          state={state}
          error={error}
          userId={userId}
          onClose={() => setModalOpen(false)}
          onSubmit={async (p) => { try { await unlock(p); } catch { /* error already in state */ } }}
        />
      )}
    </MessengerCtx.Provider>
  );
}

export function useMessenger(): Ctx {
  const v = useContext(MessengerCtx);
  if (!v) throw new Error('useMessenger called outside MessengerProvider');
  return v;
}

/**
 * Subscribe to decrypted messages for a specific conversation_id.
 * Returns persisted history (inbound + outbound) merged with live
 * inbound, oldest first. The runtime fires `onHistoryChange` whenever
 * IDB mutates so the hook stays in sync without polling.
 *
 * Outbound messages from history are surfaced with `senderUserId`
 * equal to the current user so the panel's `display` logic still
 * branches on `m.senderUserId === messenger.userId` without changes.
 */
export function useGroupMessages(conversationId: string | null): DecryptedMessage[] {
  const {runtime, state} = useMessenger();
  const [items, setItems] = useState<DecryptedMessage[]>([]);

  useEffect(() => {
    if (!runtime || !conversationId || state !== 'unlocked') return;
    let cancelled = false;

    const reload = () => {
      void runtime.loadConversation(conversationId).then(rows => {
        if (cancelled) return;
        const mapped: DecryptedMessage[] = rows.map(r => ({
          envelopeId:     r.envelopeId ?? `local|${r.id}`,
          conversationId: r.conversationId,
          senderUserId:   r.senderUserId,
          senderDeviceId: 1,
          body:           r.body,
          clientMsgId:    r.clientMsgId ?? undefined,
          receivedAt:     r.sentAt,
        }));
        setItems(mapped);
      });
    };

    reload();
    const offIncoming = runtime.onIncoming(m => {
      if (m.conversationId !== conversationId) return;
      // The runtime persists every inbound before fanning to listeners,
      // so a fresh `reload()` would cover us — but we also append in
      // place so the UI updates without waiting on the IDB roundtrip.
      setItems(prev =>
        prev.some(x => x.envelopeId === m.envelopeId) ? prev : [...prev, m],
      );
    });
    const offHistory = runtime.onHistoryChange(cid => {
      if (cid === conversationId) reload();
    });
    return () => {
      cancelled = true;
      offIncoming();
      offHistory();
    };
  }, [runtime, conversationId, state]);

  return items;
}

/**
 * Subscribe to presence for a list of userIds. The runtime registers
 * the subscription with the server on mount and tears it down on
 * unmount, so the hook can be used freely in any panel.
 */
export function usePresence(userIds: string[]): Map<string, PresenceState> {
  const {runtime, state} = useMessenger();
  const [snap, setSnap] = useState<Map<string, PresenceState>>(new Map());
  // Stable join key so the effect doesn't re-fire when callers pass a
  // fresh array reference with the same content on every render.
  const key = userIds.join(',');

  useEffect(() => {
    if (!runtime || state !== 'unlocked' || userIds.length === 0) return;
    runtime.subscribePresence(userIds);
    const off = runtime.onPresenceChange((uid, p) => {
      if (!userIds.includes(uid)) return;
      setSnap(prev => {
        const next = new Map(prev);
        next.set(uid, p);
        return next;
      });
    });
    return () => {
      off();
      runtime.unsubscribePresence(userIds);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, state, key]);

  return snap;
}

/**
 * Subscribe to typing indicators by peer userId. Returns the set of
 * userIds currently typing — typically rendered as "X is typing…".
 */
export function useTyping(peerUserIds: string[]): Set<string> {
  const {runtime, state} = useMessenger();
  const [typing, setTyping] = useState<Set<string>>(new Set());
  const key = peerUserIds.join(',');

  useEffect(() => {
    if (!runtime || state !== 'unlocked' || peerUserIds.length === 0) return;
    const off = runtime.onTypingChange((uid, isTyping) => {
      if (!peerUserIds.includes(uid)) return;
      setTyping(prev => {
        const next = new Set(prev);
        if (isTyping) next.add(uid); else next.delete(uid);
        return next;
      });
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, state, key]);

  return typing;
}

/**
 * Subscribe to read-receipt frames. Returns a set of envelope ids
 * the peer has acknowledged reading. Used to flip outbound bubbles
 * from single-tick (delivered) to double-tick (read).
 */
export function useReadReceipts(): Set<string> {
  const {runtime, state} = useMessenger();
  const [read, setRead] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!runtime || state !== 'unlocked') return;
    const off = runtime.onReadReceipt((_peerUid, envelopeIds) => {
      setRead(prev => {
        const next = new Set(prev);
        for (const id of envelopeIds) next.add(id);
        return next;
      });
    });
    return off;
  }, [runtime, state]);

  return read;
}
