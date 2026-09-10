import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * B-260 — the group-call "Add" sheet listed the phone address book instead of
 * the group roster.
 *
 * Mid-call "Add" built its candidate list from every DIRECT conversation
 * regardless of what kind of call was running. In a GROUP call that offered
 * strangers — people with no business in that group — and buried the members who
 * actually belong in it. Adding one of them to the call also means handing them
 * the call's group key material, so this is not purely cosmetic.
 *
 * The fix branches on conversation type: a group / ops_channel call draws from
 * `convo.participants` (the group's own roster); the 1:1 branch deliberately
 * KEEPS the address-book behaviour, because escalating a 1:1 to a group call
 * makes any contact a valid invitee.
 *
 * `GroupCallScreen.tsx` imports `react-native-webrtc` (RTCView) and cannot be
 * loaded by the node `messenger-crypto` project, so this is a source scan over
 * the `inviteCandidates` slice only. CRLF-safe; comments stripped before every
 * assertion — the fix's own comment names "address book", which would otherwise
 * satisfy the roster assertion for the wrong reason.
 */

const SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'GroupCallScreen.tsx');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The `inviteCandidates` memo body, CODE only. */
function inviteCandidates(): string {
  const src = readFileSync(SCREEN, 'utf8');
  const start = src.indexOf('const inviteCandidates');
  expect(start).toBeGreaterThan(-1);
  // Generous window: the memo carries both branches plus the name-resolution
  // preamble. Comments are stripped after slicing.
  const slice = src.slice(start, start + 3000);
  return stripComments(slice);
}

describe('B-260 — group-call "Add" draws from the group roster', () => {
  it('branches on the conversation type', () => {
    const body = inviteCandidates();
    expect(body).toMatch(/convo\?\.type === 'group'/);
    // Ops channels are groups too — a mission Ops Room call must not offer the
    // address book either.
    expect(body).toMatch(/convo\?\.type === 'ops_channel'/);
  });

  it('the group branch reads the group roster, not direct conversations', () => {
    expect(inviteCandidates()).toMatch(/convo\.participants/);
  });

  it('already-in-room participants are excluded', () => {
    // Otherwise the sheet offers people who are already on the call.
    expect(inviteCandidates()).toMatch(/inRoom\(/);
  });

  it('roster ids are resolved to names before display', () => {
    // The sheet must never list a raw UUID — the roster carries ids, and the
    // group's own name map may not be hydrated yet on a cold call.
    expect(inviteCandidates()).toMatch(/ensureDirectoryNames\(/);
  });
});
