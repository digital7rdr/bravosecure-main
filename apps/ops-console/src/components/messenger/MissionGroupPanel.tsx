'use client';

/**
 * Mission Group panel pair:
 *   - MissionGroupPanel  → inline status preview (member chips, lock,
 *     unread count, "OPEN CHAT" button) on the Live Ops sidebar.
 *   - MissionGroupDock   → floating bottom-right chat window opened on
 *     demand. Holds the full thread + composer like Messenger Web.
 *
 * The dock is rendered via a portal at <body> so it's never clipped
 * by the sidebar's overflow:hidden / maxHeight.
 */

import {useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import useSWR from 'swr';
import {opsApi} from '@/lib/api';
import {useGroupMessages, useMessenger, usePresence, useTyping, useReadReceipts} from './MessengerProvider';
import {broadcastToGroup} from '@/lib/messenger/groupClientAdapter';
import type {PresenceState} from '@/lib/messenger/runtime';

interface Props {
  conversationId: string | null;
  missionShortCode?: string;
}

export function MissionGroupPanel({conversationId, missionShortCode}: Props) {
  const messenger = useMessenger();
  const messages  = useGroupMessages(conversationId);
  const [open, setOpen] = useState(false);
  const [seenCount, setSeenCount] = useState(0);

  const {data: convo, error: convoErr, isLoading: convoLoading} = useSWR(
    conversationId ? ['conversation', conversationId] : null,
    () => conversationId ? opsApi.getConversation(conversationId) : null,
    {refreshInterval: 30_000},
  );

  // Reset unread when the dock opens.
  useEffect(() => { if (open) setSeenCount(messages.length); }, [open, messages.length]);
  const unread = Math.max(0, messages.length - seenCount);

  // Subscribe presence for every non-self member in the panel preview
  // so the member chips can show the live online dot. The dock will
  // resubscribe on open (idempotent) so the same data is available there.
  const otherMemberIds = useMemo(
    () => (convo?.members ?? [])
      .filter(m => m.userId !== messenger.userId)
      .map(m => m.userId),
    [convo, messenger.userId],
  );
  const presence = usePresence(otherMemberIds);

  // ── Render the inline preview card ────────────────────────────

  if (!conversationId) {
    return (
      <Pane title="Mission Group · E2E">
        <div style={empty}>No mission group exists yet — dispatch creates one.</div>
      </Pane>
    );
  }
  if (convoLoading) {
    return <Pane title="Mission Group · E2E"><div style={empty}>Loading…</div></Pane>;
  }
  if (convoErr || !convo) {
    return (
      <Pane title="Mission Group · E2E">
        <div style={errorBox}>{convoErr ? String(convoErr) : 'Conversation not found'}</div>
      </Pane>
    );
  }

  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;

  return (
    <>
      <div className="card" style={{overflow:'hidden'}}>
        <div className="pane-h" style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
          <span>Mission Group · E2E · {convo.members.length}</span>
          <span style={{fontFamily:'JetBrains Mono', fontSize:9, letterSpacing:0.6, color: lockColor(messenger.state)}}>
            {lockLabel(messenger.state)}
          </span>
        </div>

        {messenger.state !== 'unlocked' ? (
          <div style={unlockBanner}>
            <span style={{fontFamily:'JetBrains Mono', fontSize:10.5, color:'var(--tx-2)'}}>
              🔒 Vault locked
            </span>
            <button type="button" onClick={messenger.requestUnlock} style={unlockBtn}>
              UNLOCK MESSENGER
            </button>
          </div>
        ) : null}

        {/* Audit fix 4.7 — explicit "ops is in this group" banner.
            E2EE is preserved (ops decrypts on its own device with its
            own private keys, same as any crew member). This banner makes
            ops's membership obvious to the team so it's never a hidden
            wiretap. Mobile shows an equivalent banner in its mission
            group screen; the customer-facing privacy policy
            (docs/legal/privacy-ops-disclosure.md) documents the model. */}
        <div style={{
          padding:'8px 12px',
          borderBottom:'1px solid var(--bd-2)',
          background:'rgba(126,214,255,0.06)',
          fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-2)',
          letterSpacing:0.4, lineHeight:1.5,
        }}>
          <b style={{color:'var(--act)'}}>★ OPS</b> — this thread is end-to-end
          encrypted, and the ops handler (you) is a participant. Every CPO
          and customer in the roster can see the ★ badge on your name.
        </div>

        {/* Member roster — presence dot per non-self member. Self is
            never sub'd, so `presence.get(self)` is undefined; we render
            it without the indicator. */}
        <div style={{padding:'8px 12px', borderBottom:'1px solid var(--bd-2)', display:'flex', flexWrap:'wrap', gap:6}}>
          {convo.members.map(m => {
            const p = presence.get(m.userId);
            const isSelf = m.userId === messenger.userId;
            return (
              <span key={m.userId} style={chip} title={presenceTitle(p)}>
                {!isSelf && <PresenceDot state={p?.state} />}
                {m.role === 'admin' && <b style={{color:'var(--act)'}}>★ </b>}
                {m.displayName || m.userId.slice(0,8)}
              </span>
            );
          })}
        </div>

        {/* Last message preview */}
        <div style={{padding:'10px 14px', borderBottom:'1px solid var(--bd-2)', minHeight:54}}>
          {messenger.state !== 'unlocked' ? (
            <div style={{fontFamily:'JetBrains Mono', fontSize:10.5, color:'var(--tx-3)'}}>
              Unlock the vault to read & send messages.
            </div>
          ) : lastMsg ? (
            <>
              <div style={{fontFamily:'JetBrains Mono', fontSize:9, color:'var(--tx-3)', letterSpacing:0.6, marginBottom:3}}>
                LAST · {lastMsg.senderUserId === messenger.userId ? 'YOU' : lastMsg.senderUserId.slice(0,8)}
              </div>
              <div style={{fontFamily:'Manrope', fontSize:12.5, color:'var(--tx-1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                {lastMsg.body}
              </div>
            </>
          ) : (
            <div style={{fontFamily:'JetBrains Mono', fontSize:10.5, color:'var(--tx-3)'}}>
              No messages yet for {missionShortCode ?? 'this mission'}.
            </div>
          )}
        </div>

        {/* Open chat button */}
        <div style={{padding:10}}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={messenger.state !== 'unlocked'}
            style={openBtn(messenger.state !== 'unlocked')}>
            {messenger.state !== 'unlocked'
              ? 'UNLOCK FIRST'
              : unread > 0 ? `OPEN CHAT · ${unread} NEW` : 'OPEN CHAT'}
          </button>
        </div>
      </div>

      {/* Floating dock — portal'd to body so sidebar overflow can't hide it */}
      {open && messenger.state === 'unlocked' && (
        <MissionGroupDock
          conversationId={conversationId}
          missionShortCode={missionShortCode}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// ─── Floating chat dock (portal to <body>) ────────────────────────

function MissionGroupDock({
  conversationId, missionShortCode, onClose,
}: {
  conversationId: string;
  missionShortCode?: string;
  onClose: () => void;
}) {
  const messenger = useMessenger();
  const messages  = useGroupMessages(conversationId);
  // localId — generated before the broadcast so the bubble can render
  // optimistically with "SENDING" while the await is in flight.
  // clientMsgId — set when broadcastToGroup resolves; used to dedupe
  // against the (theoretical) inbound echo if/when we add one.
  const [outbox, setOutbox] = useState<Array<{
    localId: string;
    clientMsgId?: string;
    body: string;
    at: number;
    status: 'sending' | 'sent' | 'failed';
    /** Envelope ids fanned out by broadcastToGroup, one per recipient. */
    envelopeIds?: string[];
  }>>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const typingActiveRef = useRef(false);
  const receiptedIdsRef = useRef<Set<string>>(new Set());

  const {data: convo} = useSWR(
    ['conversation', conversationId],
    () => opsApi.getConversation(conversationId),
    {refreshInterval: 30_000},
  );

  const otherMemberIds = useMemo(
    () => (convo?.members ?? [])
      .filter(m => m.userId !== messenger.userId)
      .map(m => m.userId),
    [convo, messenger.userId],
  );
  const presence       = usePresence(otherMemberIds);
  const typingPeers    = useTyping(otherMemberIds);
  const readEnvelopeIds = useReadReceipts();

  // Re-affirm 'active' on dock open — MessengerProvider already set this
  // at unlock time, but doing it here too makes a backgrounded-then-
  // refocused tab snap back to active without waiting for the next
  // page mount. NOTE: no 'away' on cleanup — closing the dock doesn't
  // mean the ops admin left the messenger; the session-level state in
  // MessengerProvider owns the active/away lifecycle now.
  useEffect(() => {
    if (!messenger.runtime || messenger.state !== 'unlocked') return;
    messenger.runtime.setActivity('active');
  }, [messenger.runtime, messenger.state]);

  // Mark inbound messages read whenever the unread set grows. The
  // runtime fans the receipt back per-peer; receiptedIdsRef stops us
  // from re-firing on every render after the first.
  useEffect(() => {
    if (!messenger.runtime || messages.length === 0) return;
    const fresh = messages
      .filter(m => m.senderUserId !== messenger.userId)
      .map(m => m.envelopeId)
      .filter(id => !receiptedIdsRef.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) receiptedIdsRef.current.add(id);
    messenger.runtime.markRead(conversationId, fresh);
  }, [messenger.runtime, messenger.userId, messages, conversationId]);

  // Typing indicator sender — debounced by the 6s server-side auto-stop
  // so we only fire on transitions. Fan out to every other member; the
  // server forwards each frame only to that peer's connected sockets.
  useEffect(() => {
    if (!messenger.runtime || otherMemberIds.length === 0) return;
    const shouldType = text.trim().length > 0;
    if (shouldType && !typingActiveRef.current) {
      for (const uid of otherMemberIds) {
        messenger.runtime.sendTyping({userId: uid, deviceId: 1}, 'start');
      }
      typingActiveRef.current = true;
    } else if (!shouldType && typingActiveRef.current) {
      for (const uid of otherMemberIds) {
        messenger.runtime.sendTyping({userId: uid, deviceId: 1}, 'stop');
      }
      typingActiveRef.current = false;
    }
  }, [text, messenger.runtime, otherMemberIds]);

  // Stop typing on unmount in case the user closed the dock mid-compose.
  useEffect(() => () => {
    if (!typingActiveRef.current || !messenger.runtime) return;
    for (const uid of otherMemberIds) {
      messenger.runtime.sendTyping({userId: uid, deviceId: 1}, 'stop');
    }
    typingActiveRef.current = false;
  }, [messenger.runtime, otherMemberIds]);

  const display = useMemo(() => {
    const out: Array<{key: string; senderUserId: string | null; body: string; at: number; pending?: boolean; failed?: boolean; read?: boolean}> = [];
    for (const m of messages) {
      out.push({key: m.envelopeId, senderUserId: m.senderUserId, body: m.body, at: m.receivedAt});
    }
    for (const p of outbox) {
      // Drop the local entry once the same-clientMsgId message comes
      // back through the inbound stream (future loopback echo). For
      // now no echo exists, so the entry persists — but we render it
      // with the correct lifecycle label, not a permanent SENDING.
      if (p.clientMsgId && messages.some(m => m.clientMsgId === p.clientMsgId)) continue;
      // "Read" = at least one recipient has acknowledged the envelope.
      // For a 2-person mission group (ops + agent) this is exact; for
      // larger crews we can refine to "all recipients" later.
      const read = p.status === 'sent' && (p.envelopeIds ?? []).some(id => readEnvelopeIds.has(id));
      out.push({
        key:          'local-' + p.localId,
        senderUserId: messenger.userId,
        body:         p.body,
        at:           p.at,
        pending:      p.status === 'sending',
        failed:       p.status === 'failed',
        read,
      });
    }
    out.sort((a, b) => a.at - b.at);
    return out;
  }, [messages, outbox, messenger.userId, readEnvelopeIds]);

  const memberById = useMemo(() => {
    const m = new Map<string, {displayName: string}>();
    for (const x of convo?.members ?? []) m.set(x.userId, {displayName: x.displayName});
    return m;
  }, [convo]);

  // Audit PAGE-24 — only auto-scroll when already near the bottom (snap on
  // first paint), so a poll delivering a message doesn't yank an operator
  // reading back through history to the bottom.
  const didInitialScroll = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (!didInitialScroll.current || nearBottom) {
      el.scrollTop = el.scrollHeight;
      if (el.scrollHeight > 0) didInitialScroll.current = true;
    }
  }, [display.length]);

  const send = async () => {
    if (!text.trim() || !convo || !messenger.runtime) return;
    setSending(true); setSendErr(null);
    const body = text.trim();
    // Optimistic bubble: add to outbox BEFORE we await the network so
    // the user sees their message land immediately as SENDING.
    const localId = makeLocalId();
    setOutbox(p => [...p, {localId, body, at: Date.now(), status: 'sending'}]);
    setText('');
    try {
      const cert = await messenger.runtime.getSenderCert();
      const runtime = messenger.runtime;

      // Phase-1 simplification: skip the master-key wrap entirely. The
      // pairwise Signal session is already E2E (each recipient gets
      // their own ciphertext); the master-key layer adds defense in
      // depth but creates a bootstrap-ordering race where text frames
      // arrive before admin-create and get silently dropped on the
      // recipient. Phase-2 native libsignal will introduce Sender Keys
      // which solve this properly. For now, send plaintext-inner-
      // envelope under the pairwise session — receivers parse the
      // GroupMessageEnvelope JSON via the legacy fallback path.
      const result = await broadcastToGroup({
        conversationId,
        members: convo.members.map(m => ({userId: m.userId, displayName: m.displayName, role: m.role})),
        self:    runtime.self,
        cert,
        body,
        session: runtime.getSession(),
        store:   runtime.getStore(),
      });
      // Bubble was added optimistically; flip its status to 'sent'
      // and stamp the broadcast clientMsgId + envelope ids for future
      // read-receipt correlation.
      setOutbox(p => p.map(x => x.localId === localId
        ? {...x, clientMsgId: result.clientMsgId, status: 'sent', envelopeIds: result.envelopeIds}
        : x));
      // Persist the outbound bubble to IDB so a tab reload still
      // shows it. `clientMsgId` is the dedup key against the live
      // history merge in useGroupMessages.
      if (result.recipients > 0) {
        await runtime.recordOutbound({
          conversationId: conversationId,
          id:             localId,
          body,
          sentAt:         Date.now(),
          clientMsgId:    result.clientMsgId,
          envelopeIds:    result.envelopeIds,
          status:         'sent',
        });
      }
      if (result.failures.length > 0) {
        setSendErr(`${result.failures.length}/${convo.members.length - 1} delivery failures`);
      }
    } catch (e) {
      // Mark the optimistic bubble as failed instead of dropping it,
      // so the user can see what didn't go through and retry.
      setOutbox(p => p.map(x => x.localId === localId ? {...x, status: 'failed'} : x));
      setSendErr((e as Error).message || 'send failed');
    } finally {
      setSending(false);
    }
  };

  /**
   * Recovery affordance — used when a member reports "decrypt failed"
   * after a reinstall on their device. Closes ops's local session
   * with every non-self member, refetches their bundles, and rebuilds
   * outgoing sessions. The next message ops sends is then a fresh
   * PreKeyWhisperMessage that also rebuilds the recipient's side
   * (libsignal handles that on decrypt). Idempotent.
   */
  const [resetting, setResetting] = useState(false);
  const resetSessions = async () => {
    if (!convo || !messenger.runtime || resetting) return;
    setResetting(true); setSendErr(null);
    try {
      const others = convo.members.filter(m => m.userId !== messenger.runtime!.self.userId);
      let failed = 0;
      for (const m of others) {
        try {
          await messenger.runtime.resetSessionWith({userId: m.userId, deviceId: 1});
        } catch { failed += 1; }
      }
      if (failed > 0) setSendErr(`Reset failed for ${failed}/${others.length} members`);
    } finally {
      setResetting(false);
    }
  };

  // Render-time aggregations for the header subtitle. "X is typing"
  // wins over presence ("active now") because the typing transition
  // already implies presence, and showing both is noisy.
  const typingNames = useMemo(() => {
    const names: string[] = [];
    for (const uid of typingPeers) {
      const m = memberById.get(uid);
      if (m) names.push(m.displayName);
    }
    return names;
  }, [typingPeers, memberById]);
  const activeCount = useMemo(() => {
    let n = 0;
    for (const uid of otherMemberIds) {
      const p = presence.get(uid);
      if (p && (p.state === 'active' || p.state === 'online')) n += 1;
    }
    return n;
  }, [presence, otherMemberIds]);

  const dock = (
    <div style={dockStyle} role="dialog" aria-label="Mission Group Chat">
      {/* Header */}
      <div style={dockHeader}>
        <div style={{display:'flex', flexDirection:'column'}}>
          <span style={{fontFamily:'JetBrains Mono', fontSize:9, color:'var(--glow)', letterSpacing:1.2, fontWeight:700}}>
            E2E ENCRYPTED · {missionShortCode ?? 'MISSION'}
          </span>
          <span style={{fontFamily:'Manrope', fontSize:13, color:'var(--tx-1)', fontWeight:700, marginTop:1}}>
            Mission Group · {convo?.members.length ?? '…'} members
          </span>
          <span style={{fontFamily:'JetBrains Mono', fontSize:9, color:typingNames.length>0?'var(--act)':'var(--tx-3)', marginTop:2, letterSpacing:0.6}}>
            {typingNames.length > 0
              ? `${formatTypingNames(typingNames)} typing…`
              : activeCount > 0 ? `${activeCount} active` : 'no one active'}
          </span>
        </div>
        <button type="button" onClick={onClose} style={closeBtn} aria-label="Close">×</button>
      </div>

      {/* Thread */}
      <div ref={scrollRef} style={dockThread}>
        {display.length === 0 ? (
          <div style={{...empty, textAlign:'center'}}>
            No messages yet. Send the first one below — it will be E2E-encrypted to every CPO in the crew.
          </div>
        ) : display.map(m => (
          <Bubble
            key={m.key}
            self={m.senderUserId === messenger.userId}
            label={m.senderUserId
              ? (memberById.get(m.senderUserId)?.displayName ?? m.senderUserId.slice(0,8))
              : '—'}
            body={m.body}
            at={m.at}
            pending={m.pending}
            failed={m.failed}
            read={m.read}
          />
        ))}
      </div>

      {/* Composer */}
      {sendErr && <div style={errorBoxStripe}>{sendErr}</div>}
      <div style={composer}>
        <input
          type="text"
          autoFocus
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="E2E message to crew…"
          disabled={sending}
          style={input}
        />
        <button
          type="button"
          disabled={sending || !text.trim()}
          onClick={() => { void send(); }}
          style={sendBtn(sending || !text.trim())}>
          {sending ? '…' : 'SEND'}
        </button>
      </div>

      {/* Recovery: visible only when last send reported failures, so
          ops can act when crew reports "I can't decrypt". Hidden in
          the happy path so the chat dock stays clean. */}
      {sendErr && sendErr.includes('failure') && (
        <div style={{padding:'4px 8px 8px', borderTop:'1px solid var(--bd-2)', background:'var(--surf-2)'}}>
          <button
            type="button"
            disabled={resetting}
            onClick={() => { void resetSessions(); }}
            style={{
              width:'100%', padding:'6px 10px', borderRadius:6,
              background:'var(--surf-3)', border:'1px solid var(--warn)',
              color:'var(--warn)', fontFamily:'JetBrains Mono', fontSize:10,
              fontWeight:700, letterSpacing:0.6, cursor: resetting ? 'wait' : 'pointer',
            }}>
            {resetting ? 'RESETTING…' : 'RESET CREW SESSIONS (after reinstall)'}
          </button>
        </div>
      )}
    </div>
  );

  if (typeof window === 'undefined') return null;
  return createPortal(dock, document.body);
}

// ─── Reusable bits ──────────────────────────────────────────────

function Bubble({self, label, body, at, pending, failed, read}: {
  self: boolean; label: string; body: string; at: number; pending?: boolean; failed?: boolean; read?: boolean;
}) {
  const time = new Date(at);
  const stamp = `${time.getUTCHours().toString().padStart(2,'0')}:${time.getUTCMinutes().toString().padStart(2,'0')}Z`;
  // WhatsApp-style ticks: nothing while sending, single grey when sent,
  // double cyan when the peer's read-receipt has arrived. Failed sends
  // get an explicit FAILED label instead.
  let tick = '';
  if (self) {
    if (failed) tick = '· FAILED';
    else if (pending) tick = '· SENDING';
    else if (read) tick = '✓✓';
    else tick = '✓';
  }
  return (
    <div style={{
      display:'flex', flexDirection:'column',
      alignItems: self ? 'flex-end' : 'flex-start',
      marginBottom: 8,
      opacity: pending ? 0.55 : 1,
    }}>
      <div style={{
        fontFamily:'JetBrains Mono', fontSize:9, letterSpacing:0.6, marginBottom:2,
        color: failed ? 'var(--err)' : 'var(--tx-3)',
      }}>
        {self ? 'YOU' : label.toUpperCase()} · {stamp}{tick ? ' ' : ''}
        <span style={{color: read && self ? 'var(--act)' : undefined}}>{tick}</span>
      </div>
      <div style={{
        padding:'8px 12px', borderRadius:10, maxWidth:'78%',
        background: self ? 'var(--act-dim)' : 'var(--surf-2)',
        border: failed
          ? '1px solid var(--err)'
          : self ? '1px solid var(--act)' : '1px solid var(--bd-2)',
        fontFamily:'Manrope', fontSize:13.5, color:'var(--tx-1)', whiteSpace:'pre-wrap', lineHeight:1.4,
      }}>
        {body}
      </div>
    </div>
  );
}

function makeLocalId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

/** Coloured dot that maps presence state → status colour. */
function PresenceDot({state}: {state?: PresenceState['state']}) {
  let bg = 'var(--tx-3)'; // unknown / offline
  if (state === 'active') bg = 'var(--ok, #21c178)';
  else if (state === 'online') bg = 'var(--ok, #21c178)';
  else if (state === 'away') bg = 'var(--warn, #d8a531)';
  return (
    <span style={{
      display:'inline-block', width:6, height:6, borderRadius:3,
      background: bg, marginRight: 4, flexShrink: 0,
    }} />
  );
}

function presenceTitle(p?: PresenceState): string {
  if (!p) return 'offline';
  if (p.state === 'active') return 'active now';
  if (p.state === 'online') return 'online';
  if (p.state === 'away')   return p.lastSeenMs ? `last seen ${formatLastSeen(p.lastSeenMs)}` : 'away';
  return 'offline';
}

function formatLastSeen(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000)        return 'just now';
  if (delta < 3_600_000)     return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000)    return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function formatTypingNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]} are`;
  return `${names[0]} and ${names.length - 1} others are`;
}

function Pane({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <div className="card" style={{overflow:'hidden'}}>
      <div className="pane-h">{title}</div>
      {children}
    </div>
  );
}

function lockLabel(s: string): string {
  return s === 'unlocked' ? '🔓 UNLOCKED' : s === 'unlocking' ? 'UNLOCKING…' : '🔒 LOCKED';
}
function lockColor(s: string): string {
  return s === 'unlocked' ? 'var(--ok)' : s === 'unlocking' ? 'var(--warn)' : 'var(--tx-3)';
}

const empty: React.CSSProperties = {
  padding:'14px 14px', color:'var(--tx-3)', fontFamily:'JetBrains Mono', fontSize:11,
};
const errorBox: React.CSSProperties = {
  padding:'10px 14px', color:'#FFB4B4', fontFamily:'JetBrains Mono', fontSize:11,
  background:'rgba(220,38,38,0.1)', border:'1px solid var(--err)', borderRadius:6, margin:12,
};
const errorBoxStripe: React.CSSProperties = {
  padding:'6px 12px', background:'rgba(220,38,38,0.1)',
  borderTop:'1px solid var(--err)', color:'#FFB4B4',
  fontFamily:'JetBrains Mono', fontSize:10,
};
const chip: React.CSSProperties = {
  fontFamily:'JetBrains Mono', fontSize:9.5, letterSpacing:0.4,
  background:'var(--surf-3)', border:'1px solid var(--bd-2)',
  borderRadius:5, padding:'3px 7px', color:'var(--tx-2)',
};
const composer: React.CSSProperties = {
  display:'flex', gap:6, padding:8, borderTop:'1px solid var(--bd-2)', background:'var(--surf-2)',
};
const input: React.CSSProperties = {
  flex:1, background:'var(--surf-3)', border:'1px solid var(--bd-1)',
  borderRadius:6, padding:'7px 10px',
  fontFamily:'Manrope', fontSize:12.5, color:'var(--tx-1)', outline:'none',
};
const unlockBanner: React.CSSProperties = {
  display:'flex', alignItems:'center', justifyContent:'space-between', gap:10,
  padding:'10px 12px',
  background:'linear-gradient(180deg, rgba(255,193,7,0.10), rgba(255,193,7,0.03))',
  borderBottom:'1px solid rgba(255,193,7,0.35)',
};
const unlockBtn: React.CSSProperties = {
  background:'var(--act)', color:'#fff',
  border:'none', borderRadius:6,
  padding:'7px 14px',
  fontFamily:'Manrope', fontSize:11, fontWeight:800, letterSpacing:0.6,
  cursor:'pointer', whiteSpace:'nowrap',
};
function sendBtn(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? 'var(--surf-3)' : 'var(--act)',
    color: disabled ? 'var(--tx-3)' : '#fff',
    border:'none', borderRadius:6,
    padding:'7px 14px',
    fontFamily:'Manrope', fontSize:11, fontWeight:800, letterSpacing:0.6,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
  };
}
function openBtn(disabled: boolean): React.CSSProperties {
  return {
    width:'100%',
    // Hardcoded colors — earlier var(--act) inherited a value that
    // blended with the panel background and the button rendered
    // invisibly. Bright blue + visible border guarantees it's seen.
    background: disabled ? '#31446E' : '#5B8DEF',
    color:      disabled ? '#8B95A8' : '#FFFFFF',
    border:     disabled ? '1px solid #31446E' : '2px solid #8FB0F7',
    borderRadius: 8,
    padding:    '12px 14px',
    fontFamily: 'Manrope',
    fontSize:   13,
    fontWeight: 800,
    letterSpacing: 0.8,
    cursor:     disabled ? 'not-allowed' : 'pointer',
    opacity:    disabled ? 0.55 : 1,
    boxShadow:  disabled ? 'none' : '0 0 0 2px rgba(91,141,239,0.25), 0 4px 14px rgba(91,141,239,0.35)',
    textTransform: 'uppercase',
  };
}
const dockStyle: React.CSSProperties = {
  position:'fixed', right:24, bottom:24,
  width:380, height:520, maxHeight:'70vh',
  display:'flex', flexDirection:'column',
  background:'var(--surf-1)', border:'1px solid var(--bd-1)',
  borderRadius:12, overflow:'hidden',
  boxShadow:'0 18px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(91,141,239,0.18)',
  zIndex:900,
};
const dockHeader: React.CSSProperties = {
  display:'flex', alignItems:'center', justifyContent:'space-between',
  padding:'10px 14px', background:'var(--surf-2)',
  borderBottom:'1px solid var(--bd-2)', flex:'0 0 auto',
};
const dockThread: React.CSSProperties = {
  flex:1, overflowY:'auto', padding:'12px 14px',
  display:'flex', flexDirection:'column', minHeight:0,
};
const closeBtn: React.CSSProperties = {
  background:'none', border:'none', color:'var(--tx-3)', cursor:'pointer',
  fontSize:20, padding:0, lineHeight:1,
};
