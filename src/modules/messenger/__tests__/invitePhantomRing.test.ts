/**
 * B-299 — mid-call "Add" shows a 30-second "Ringing…" for a ring that was
 * never sent.
 *
 * `useGroupCall.inviteUsers` opened with
 *
 *     const ws = transportRef.current;
 *     if (!ws || !roomId || userIds.length === 0) {return;}
 *
 * All three conditions took the SAME exit, and that exit is an ordinary
 * `return` from an `async` function — which resolves. The caller cannot tell
 * it apart from a delivered ring:
 *
 *     setInviteRingExpiry(... Date.now() + INVITE_RING_WINDOW_MS)  // optimistic
 *     try { await call.inviteUsers([picked.userId]); }
 *     catch (e) { ...clear the countdown...; Alert.alert('Invite failed', ...) }
 *
 * The countdown is cleared ONLY on a throw. So when the transport or the room
 * is not ready — precisely the window right after an escalation, when the host
 * has navigated into a fresh GroupCallScreen and `roomId` is still being
 * assigned — the invitee is never rung, no error is raised, and the host
 * watches a 30s countdown for nothing. That is the "add call is not working"
 * report.
 *
 * "Nothing was asked for" (`userIds.length === 0`) is genuinely benign and must
 * stay a quiet no-op; "we could not ask" is a failure and must be loud. They
 * are different outcomes and must stop sharing an exit.
 *
 * `useGroupCall.ts` pulls in react-native-webrtc and RN modules, so the node
 * project cannot import it — comment-stripped source scan. The file is CRLF, so
 * nothing here is `\n`-anchored (a `\n` anchor matches nothing and passes
 * VACUOUSLY).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'), 'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\r\n]*/g, '');

/** The body of `inviteUsers`, up to the next top-level `useCallback` sibling. */
function inviteUsersBody(): string {
  const at = src.indexOf('const inviteUsers = useCallback');
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf('const reRing = useCallback', at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
}

describe('B-299 — a ring that could not be sent must not look like one that was', () => {
  it('a missing transport or roomId THROWS instead of resolving', () => {
    const body = inviteUsersBody();
    // The exact shape that shipped the bug: one silent `return` covering the
    // not-ready case as well as the nothing-to-do case.
    expect(body).not.toMatch(/if \(!ws \|\| !roomId \|\| userIds\.length === 0\) \{\s*return;\s*\}/);
    // The not-ready case must raise, so `handleInvite`'s catch clears the
    // optimistic countdown and surfaces the failure.
    expect(body).toMatch(/if \(!ws \|\| !roomId\)[\s\S]{0,200}throw new Error\(/);
  });

  it('an empty invitee list stays a quiet no-op', () => {
    // Nothing was asked for. Throwing here would turn a harmless double-tap
    // into a visible "Invite failed" alert.
    expect(inviteUsersBody()).toMatch(/userIds\.length === 0[\s\S]{0,80}return;/);
  });

  it('the caller still clears its optimistic countdown on failure', () => {
    // The fix is only useful because this catch exists — if a refactor drops it,
    // the throw becomes an unhandled rejection and the phantom countdown is back.
    const screen = readFileSync(
      join(process.cwd(), 'src', 'screens', 'messenger', 'GroupCallScreen.tsx'), 'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\r\n]*/g, '');
    const at = screen.indexOf('await call.inviteUsers(');
    expect(at).toBeGreaterThan(-1);
    const after = screen.slice(at, at + 400);
    expect(after).toMatch(/catch/);
    expect(after).toMatch(/setInviteRingExpiry/);
  });
});
