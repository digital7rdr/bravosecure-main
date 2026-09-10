/**
 * B-300 — a mid-call invitee is RUNG but never KEYED, so they can never join.
 *
 * `useGroupCall.inviteUsers` sent `sfu.ring` and nothing else. Both
 * `ensureCallGroupKey` call sites — `useGroupCall.ts:1583` (host boot) and
 * `:1685` (owner join-resync) — pass `opts.recipientUserIds`, the recipient list
 * captured at screen MOUNT. Someone added mid-call is not in that list, so the
 * group master key is never fanned out to them. They accept, join, wait in
 * `waitForGroupCallKey` for its 25 s window, and then fail closed.
 *
 * On an ESCALATED (ad-hoc) call every heal path is closed to them as well:
 *   - the joiner's own `requestGroupKeyResync(opts.conversationId)` targets the
 *     reused 1:1 conversation id (`CallScreen.tsx:1864`) — the invitee is not a
 *     member of that conversation;
 *   - the owner's join-resync is gated on `shouldOwnerResyncOnJoin({isRealNamedGroup})`,
 *     and `isRealNamedGroup` requires `grp?.name !== 'Call'` — an ad-hoc
 *     escalated call is exactly `name === 'Call'`.
 *
 * ARCHITECTURE. This is not a design choice, it is a violation of the documented
 * one. `docs/architecture/ARCHITECTURE_AMENDMENT_SFRAME.md` states participants
 * hold a key "derived on-device from the group master key (already distributed
 * via pairwise Signal sessions)", and that "group master key rotation on
 * member-add / member-remove triggers a frame-cryptor key rotation in the same
 * epoch". Member-add is required to distribute. Nothing here weakens a check:
 * the 25 s fail-closed gate, `verifySenderCert` and the owner-forgery guard are
 * all untouched — an invitee that still receives no key still gets no media.
 *
 * `ensureCallGroupKey` already does the right thing when handed the wider
 * roster: its resync branch is guarded by `others.every(uid => !!mapped.members[uid])`,
 * so a roster containing someone outside the minted state falls through to a
 * FRESH MINT covering everyone (`productionRuntime.ts:5613-5620`) — which is the
 * rotation the amendment asks for. The call site simply never invoked it.
 *
 * ORDER IS THE FIX. Keying must complete BEFORE the ring: ringing first
 * re-creates the same race in a smaller window, and a keying failure must abort
 * the invite rather than summon someone who cannot join. Paired with B-299, a
 * throw here reaches `handleInvite`'s catch, clears the optimistic countdown and
 * tells the host — instead of a silent 30 s "Ringing…" for a doomed invitee.
 *
 * `useGroupCall.ts` pulls in react-native-webrtc, so the node project cannot
 * import it — comment-stripped source scan. The file is CRLF, so nothing here is
 * `\n`-anchored (a `\n` anchor matches nothing and passes VACUOUSLY).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'), 'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\r\n]*/g, '');

function inviteUsersBody(): string {
  const at = src.indexOf('const inviteUsers = useCallback');
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf('const reRing = useCallback', at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
}

describe('B-300 — you may not ring someone you have not keyed', () => {
  it('inviteUsers keys the invitee at all', () => {
    expect(inviteUsersBody()).toMatch(/ensureCallGroupKey\(/);
  });

  it('the key roster INCLUDES the new invitees, not just the mount-time list', () => {
    // Passing only `opts.recipientUserIds` is the bug verbatim — that is what
    // both pre-existing call sites do, and why the invitee is skipped.
    const body = inviteUsersBody();
    expect(body).toMatch(/ensureCallGroupKey\(\{[\s\S]{0,300}recipientUserIds:[\s\S]{0,160}userIds/);
  });

  it('keying happens BEFORE the ring', () => {
    // Ringing first only shrinks the race window; it does not close it, and it
    // still summons someone who may never be keyed.
    const body = inviteUsersBody();
    const keyAt  = body.indexOf('ensureCallGroupKey(');
    const ringAt = body.indexOf("'sfu.ring'");
    expect(keyAt).toBeGreaterThan(-1);
    expect(ringAt).toBeGreaterThan(-1);
    expect(keyAt).toBeLessThan(ringAt);
  });

  it('a keying failure ABORTS the invite instead of ringing anyway', () => {
    // Must reach handleInvite's catch (B-299) so the optimistic 30s countdown
    // clears and the host is told, rather than watching a doomed invitee ring.
    expect(inviteUsersBody()).toMatch(/ensureCallGroupKey[\s\S]{0,600}throw new Error\(/);
  });

  it('the fail-closed join gate is UNTOUCHED', () => {
    // The fix distributes a key earlier; it must never relax what happens when
    // a key is still missing. No key ⇒ no media, never plaintext.
    expect(src).toMatch(/waitForGroupCallKey\(/);
    expect(src).toMatch(/hostWait === 'timeout'/);
  });
});
