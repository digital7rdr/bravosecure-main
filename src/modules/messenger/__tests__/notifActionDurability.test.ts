/**
 * B-359 / B-360 / B-361 — source scans (the guarded files import RN/notifee and
 * cannot be mounted by the node Jest project; see the messenger test contract in
 * CLAUDE.md — a scan is a real gate as long as comments are stripped before any
 * absence assertion and no regex assumes LF-only line endings).
 *
 * B-359 — whatwg-fetch status-0 crash. A fetch whose XHR completes with a
 *   status outside [200, 599] (0 = dead connection / blocked redirect) made the
 *   polyfill construct `new Response(body, {status: 0})` INSIDE an async
 *   callback: the RangeError is uncatchable by the fetch caller and killed the
 *   whole app (FATAL EXCEPTION mqt_v_native, bs5555 2026-08-01 11:45:19). The
 *   patch-package file must keep rejecting that case like a network error.
 *
 * B-360 — CallScreen ran expo-camera's CameraView (androidx CameraX) as the
 *   ringing self-preview while react-native-webrtc capture needs the SAME
 *   front camera: CameraX loses the device at accept and loops
 *   ERROR_CAMERA_IN_USE reopen attempts that steal the capture back — black
 *   self-video on MIUI (Redmi 2026-08-01 12:46) and camera churn behind every
 *   escalation. Call surfaces must never mount a second camera stack.
 *
 * B-361 — notification-action replies/reads dispatched against a not-yet
 *   hydrated store: the group path fell to 1:1 and threw "production mode
 *   requires explicit peer address" on EVERY reconnect retry, each attempt
 *   appending ANOTHER failed bubble of the same typed text (Redmi 2026-08-01
 *   12:46:47–:51, four attempts) — the founder's "reply does not send and it
 *   duplicates". The drain must wait for hydration, pass the banner's sender as
 *   the explicit 1:1 peer (never for groups), and pin retries to a stable
 *   bubble id so appendMessage's id-dedup collapses them.
 */
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8');
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('B-359 — whatwg-fetch out-of-range status must reject, not crash', () => {
  const patchPath = join(process.cwd(), 'patches', 'whatwg-fetch+3.6.20.patch');

  it('the patch file exists (postinstall re-applies it on every npm install)', () => {
    expect(existsSync(patchPath)).toBe(true);
  });

  it('the patch converts status<200/status>599 into a rejected fetch', () => {
    const patch = readFileSync(patchPath, 'utf8');
    expect(patch).toMatch(/options\.status < 200 \|\| options\.status > 599/);
    expect(patch).toMatch(/Network request failed: status/);
    // The guard must REJECT — resolving a synthetic response would silently
    // change every caller's error handling.
    expect(patch).toMatch(/reject\(new TypeError\('Network request failed: status/);
  });

  it('the installed module carries the guard (patch actually applied)', () => {
    const mod = read('node_modules', 'whatwg-fetch', 'dist', 'fetch.umd.js');
    expect(mod).toContain('Network request failed: status');
  });
});

describe('B-360 — CallScreen must not mount a second camera stack', () => {
  const src = stripComments(read('src', 'screens', 'messenger', 'CallScreen.tsx'));

  it('no expo-camera import and no CameraView element', () => {
    expect(src).not.toContain('expo-camera');
    expect(src).not.toContain('<CameraView');
  });

  it('the PiP previews the WebRTC local stream whenever the camera is on (not only liveMode)', () => {
    expect(src).toMatch(/const localUrl = isCameraOn \? safeStreamURL\(liveCall\.localStream\) : null;/);
  });
});

describe('B-361 — notification-action reply/read durability', () => {
  const boot = read('src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts');
  const slim = read('src', 'modules', 'messenger', 'push', 'callNotification.ts');
  const pend = read('src', 'modules', 'messenger', 'push', 'pendingActions.ts');
  const prod = read('src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');
  const rt   = read('src', 'modules', 'messenger', 'runtime', 'runtime.ts');

  it('sendText honours a caller-pinned stable bubble id', () => {
    expect(rt).toMatch(/stableMsgId\?: string;/);
    expect(prod).toMatch(/const msgId = opts\.existingMsgId \?\? opts\.stableMsgId \?\? makeId\(\);/);
  });

  it('the drain waits for store hydration before dispatching replies/reads', () => {
    const drainStart = boot.indexOf('async function drainPendingActions');
    expect(drainStart).toBeGreaterThan(-1);
    const drain = boot.slice(drainStart, boot.indexOf('\n}', drainStart + 1000));
    expect(drain).toContain('onFinishHydration');
    expect(drain).toMatch(/hasReplyOrRead/);
  });

  it('the drain pins retries to the entry-stable bubble id', () => {
    expect(boot).toMatch(/stableMsgId: `notifreply-\$\{e\.id\}`/);
  });

  it('the explicit peer applies ONLY when the conversation is known 1:1', () => {
    // isGroup===undefined must pass neither hint — forcing a GROUP reply down
    // the 1:1 path would deliver it as a private DM to the sender.
    expect(boot).toMatch(/isGroup === false && e\.peerUserId/);
    expect(boot).not.toMatch(/!isGroup && e\.peerUserId/);
  });

  it('both enqueue sites carry the banner sender uid for the 1:1 fallback', () => {
    const pattern = /t: 'reply', convId, text: input\.trim\(\), peerUserId: data\.senderUserId \|\| undefined/;
    expect(slim).toMatch(pattern);   // slim killed-VM handler
    expect(boot).toMatch(pattern);   // rich warm handler (enqueue-then-drain)
  });

  it('the warm reply handler dispatches through the shared durable drain', () => {
    const warmStart = boot.indexOf("pressId.startsWith('reply-')");
    expect(warmStart).toBeGreaterThan(-1);
    const warm = boot.slice(warmStart, warmStart + 1600);
    expect(warm).toContain('enqueuePendingAction');
    expect(warm).toContain('drainPendingActions()');
    // The direct un-durable send must be gone: a thrown sendText here dropped
    // the typed reply.
    expect(warm).not.toMatch(/sendText\?\.\(convId/);
  });

  it('PendingReply persists the peer uid', () => {
    expect(pend).toMatch(/interface PendingReply\s+\{ t: 'reply';\s+id: string; convId: string; text: string; peerUserId\?: string; ts: number; \}/);
  });
});

describe('B-362 — the escalating host maps its own direct:<self> handle at mint', () => {
  it('ensureCallGroupKey files the self-handle joiners address', () => {
    // Without this the host resolves an invitee key-request for
    // `direct:<host>` to nothing and declines "we hold no state" — the
    // invitee sits at "Joining…" until the 25 s key timeout (13:31:43 logs).
    const prod = read('src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');
    const mint = prod.indexOf('ensureCallGroupKey: async');
    expect(mint).toBeGreaterThan(-1);
    const block = prod.slice(mint, prod.indexOf('markRead: (conversationId', mint));
    expect(block).toContain('setCallKeyMapping(`direct:${ownAddress.userId}`, state.groupId)');
  });
});

describe('B-363 — killed-app reply/read dispatch NOW (WhatsApp parity)', () => {
  const slim = read('src', 'modules', 'messenger', 'push', 'callNotification.ts');
  const boot = read('src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts');

  it('fcmBootstrap exports the headless dispatcher, gated on the persisted-config boot', () => {
    const fn = boot.indexOf('export async function headlessDispatchNotifActions');
    expect(fn).toBeGreaterThan(-1);
    const body = boot.slice(fn, fn + 2600);
    expect(body).toContain('configureRuntimeFromPersisted');
    expect(body).toContain('drainPendingActions()');
  });

  it('the slim killed-VM handler dispatches for BOTH reply and mark-as-read', () => {
    const occurrences = slim.split('headlessDispatchNotifActions').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(4); // 2 requires + 2 calls
  });

  it('the "will send when you open" banner survives only as the FAILURE fallback', () => {
    const replyStart = slim.indexOf("pressId.startsWith('reply-')");
    const replyBlock = slim.slice(replyStart, slim.indexOf("pressId.startsWith('read-')", replyStart));
    expect(replyBlock).toMatch(/if \(sentNow\)[\s\S]{0,200}?dismissMessageNotif/);
    expect(replyBlock).toMatch(/else\s*\{\s*await markReplyQueued/);
  });
});

describe('B-366 — the 1:1 self-view PiP rests TOP-right, clear of the control sheet', () => {
  it('CallScreen anchors the PiP at top:120/right:16 with a real control-sheet keep-out', () => {
    const src = stripComments(read('src', 'screens', 'messenger', 'CallScreen.tsx'));
    expect(src).toMatch(/\{top: 120, right: 16, transform: pipPan\.getTranslateTransform\(\)\}/);
    expect(src).toMatch(/const restingTop\s+= 120;/);
    expect(src).toMatch(/bottomInset: 340/);
    // The buried-under-the-buttons anchor must be gone.
    expect(src).not.toMatch(/\{bottom: 140, right: 16/);
  });
});

describe('B-365 (partial) — group-call tiles resolve a known userId through the name chain before showing the tag', () => {
  it('labelFor falls back to resolveMemberName for identity-with-no-name', () => {
    const src = read('src', 'screens', 'messenger', 'GroupCallScreen.tsx');
    const anchor = src.indexOf('const labelFor');
    expect(anchor).toBeGreaterThan(-1);
    const block = src.slice(anchor, anchor + 1200);
    expect(block).toContain('resolveMemberName(id.userId, ownerUserId ?? undefined, conversationId)');
    expect(block).toContain('tag.slice(0, 6).toUpperCase()');
  });
});

describe('B-365 — every call join fires the proactive roster refresh', () => {
  it('useGroupCall requests a cooldown-guarded group-state resync after joining', () => {
    // A stale roster with the key already present has NO other reconcile
    // trigger: the drifted device never asks and nobody sends it a create.
    const src = read('src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts');
    const anchor = src.indexOf('B-365 roster refresh requested');
    expect(anchor).toBeGreaterThan(-1);
    const start = src.lastIndexOf('useEffect', anchor);
    const block = src.slice(start, anchor);
    expect(block).toContain("if (state !== 'joined') {return;}");
    expect(block).toContain('{divergence: true}');
    expect(block).toMatch(/startsWith\('direct:'\)[\s\S]{0,120}?direct:\$\{opts\.hostUserId\}/);
  });
});

describe('B-364 — the 1:1 send derives its peer when the caller has none', () => {
  it('sendText resolves direct:<uid> ids and conversation-row peers before failing', () => {
    const prod = read('src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');
    const anchor = prod.indexOf('const derivedPeer');
    expect(anchor).toBeGreaterThan(-1);
    const block = prod.slice(anchor, anchor + 900);
    // #19 — the inlined slice moved into the ONE grammar module.
    expect(block).toContain('peerFromDirectSlot(conversationId)');
    expect(block).toContain('conversations[conversationId]');
    expect(block).toMatch(/const target = opts\.peer \?\? derivedPeer \?\? \{userId: '', deviceId: 1\};/);
  });
});

describe('B-365b — roster-heal identity re-announce', () => {
  it('selectUnsentMembers skips self, dedups, and honours the sent-set', () => {
    jest.isolateModules(() => {
      const reg = require('@/modules/messenger/webrtc/groupCallIdentityRegistry') as
        typeof import('@/modules/messenger/webrtc/groupCallIdentityRegistry');
      const room = 'room-b365b';
      expect(reg.selectUnsentMembers(room, ['me', 'a', 'b', 'a', ''], 'me')).toEqual(['a', 'b']);
      reg.markPresenceSent(room, ['a']);
      expect(reg.selectUnsentMembers(room, ['me', 'a', 'b'], 'me')).toEqual(['b']);
      reg.markPresenceSent(room, ['b']);
      expect(reg.selectUnsentMembers(room, ['me', 'a', 'b'], 'me')).toEqual([]);
    });
  });

  it('useGroupCall re-announces on roster change while joined (source scan)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'), 'utf8');
    const anchor = src.indexOf('roster-heal identity announce');
    expect(anchor).toBeGreaterThan(-1);
    const start = src.lastIndexOf('useEffect', anchor);
    const block = src.slice(start, anchor);
    expect(block).toContain("if (state !== 'joined' || !roomId) {return;}");
    expect(block).toContain('selectUnsentMembers(rid');
    expect(block).toContain('markPresenceSent(rid, targets);');
    const after = src.slice(anchor, anchor + 600);
    expect(after).toContain('useMessengerStore.subscribe(() => announce())');
  });
});

describe('Group member row — WhatsApp parity actions (founder 2026-08-01)', () => {
  it('tapping a member offers Message privately / Save contact; admin rename moved into the sheet', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', 'ChatInfoScreen.tsx'), 'utf8');
    expect(src).toContain("{text: 'Message privately', onPress: () => openMemberChat(m.userId, m.name)}");
    expect(src).toContain("{text: 'Save contact', onPress: () => { void saveMemberContact(m.name, phone); }}");
    expect(src).toContain('onPress={() => onMemberTap(m)}');
    // The old admin-only gating must be gone: every non-self member row is tappable.
    expect(src).not.toContain('disabled={!isAdmin || m.isSelf}');
    // The 1:1 jump resolves the CANONICAL conversation (server-UUID row when
    // it exists), the same rule the send path uses.
    expect(src).toContain('resolveDirectConversationIdFromState(useMessengerStore.getState(), userId)');
  });
});

describe('Founder bugs 2026-08-01 evening — member-chat row, independent remove, foreign-chat call bar', () => {
  it('Message privately seeds the synthetic conversation row (chat list + presence need it)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', 'ChatInfoScreen.tsx'), 'utf8');
    const fn = src.indexOf('const openMemberChat');
    const block = src.slice(fn, fn + 1400);
    expect(block).toContain("if (canonical.startsWith('direct:'))");
    expect(block).toContain('upsertConversation({');
    expect(block).toContain('peer:           {userId, deviceId: 1}');
  });

  it('Remove from group is an independent sheet action taking an explicit target', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', 'ChatInfoScreen.tsx'), 'utf8');
    expect(src).toContain("{text: 'Remove from group', style: 'destructive', onPress: () => confirmRemoveMember(m.userId)}");
    expect(src).toContain('const confirmRemoveMember = (targetUserId?: string)');
  });

  it('the minimized group-call bar hides ONLY inside a different conversation chat', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', 'FloatingCallOverlay.tsx'), 'utf8');
    const anchor = src.indexOf('foreignChat');
    expect(anchor).toBeGreaterThan(-1);
    const block = src.slice(src.indexOf('groupActive?.isMinimized'), anchor + 600);
    expect(block).toContain("cur?.name === 'Chat'");
    expect(block).toContain('!== groupActive.conversationId');
  });
});
