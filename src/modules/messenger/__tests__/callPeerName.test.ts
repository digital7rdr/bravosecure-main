/**
 * B-695 — CallScreen's peer name survives a mid-call B-18 merge and walks the
 * B-411 ladder instead of collapsing to 'Contact'.
 *
 * sqa.md bug register — this suite pins: B-695.
 *
 * Founder repro: call shows the name; minimise + return shows "CONTACT". The
 * route's conversationId (a synthetic `direct:<peer>`) was deleted mid-call by
 * the B-18 merge when the server-UUID row materialized; the remount looked up
 * the dead id and fell to the bare fallback. These pins hold the two fixes:
 * canonical-row fallback via the peer id, and the name → directory → phone
 * ladder shared with every other surface.
 */
import {resolveCallConversation, resolveCallPeerName} from '../runtime/callPeerName';
import type {LocalConversation} from '../store/types';

const PEER = '3165d0e1-0d3f-4d8c-be5d-a4b85d11b453';

const direct = (id: string, over: Partial<LocalConversation> = {}): LocalConversation => ({
  id,
  type: 'direct',
  name: 'Ranak',
  peer: {userId: PEER, deviceId: 1},
  participants: [PEER],
  ...over,
} as LocalConversation);

describe('B-695 — the founder repro: dead route id after the B-18 merge', () => {
  it('falls back to the CANONICAL server-UUID row when the synthetic id died mid-call', () => {
    const s = {
      // The synthetic `direct:<peer>` row is GONE (merged away); only the
      // server-UUID row remains — exactly the post-merge store shape.
      conversations: {'uuid-42': direct('uuid-42', {name: 'Ranak'})},
    };
    expect(resolveCallPeerName(s, `direct:${PEER}`, PEER)).toBe('Ranak');
    expect(resolveCallConversation(s, `direct:${PEER}`, PEER)?.id).toBe('uuid-42');
  });

  it('the live route id still wins when its row exists', () => {
    const s = {
      conversations: {
        [`direct:${PEER}`]: direct(`direct:${PEER}`, {name: 'Synthetic Name'}),
        'uuid-42':          direct('uuid-42', {name: 'Server Name'}),
      },
    };
    expect(resolveCallPeerName(s, `direct:${PEER}`, PEER)).toBe('Synthetic Name');
  });
});

describe('B-695 — the B-411 ladder (never a bare store miss)', () => {
  it('a placeholder-named row falls to the directory name', () => {
    const s = {
      conversations: {'uuid-42': direct('uuid-42', {name: `Bravo · ${PEER.slice(0, 8)}`, name_source: 'placeholder' as const})},
      directoryNames: {[PEER]: 'Ranak (Directory)'},
    };
    expect(resolveCallPeerName(s, 'uuid-42', PEER)).toBe('Ranak (Directory)');
  });

  it('no name and no directory entry falls to the phone number', () => {
    const s = {
      conversations: {'uuid-42': direct('uuid-42', {name: undefined as unknown as string, phoneE164: '+8801812345678'})},
    };
    expect(resolveCallPeerName(s, 'uuid-42', PEER)).toBe('+8801812345678');
  });

  it("'Contact' survives ONLY for a peer the app knows nothing about", () => {
    expect(resolveCallPeerName({conversations: {}}, `direct:${PEER}`, PEER)).toBe('Contact');
    // …and even then, a directory entry alone is enough to name them.
    expect(resolveCallPeerName(
      {conversations: {}, directoryNames: {[PEER]: 'Ranak'}},
      `direct:${PEER}`, PEER,
    )).toBe('Ranak');
  });
});
