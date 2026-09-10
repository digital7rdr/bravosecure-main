import {routeInboundEnvelope} from '../runtime/inboundRouting';

/**
 * Seam S3 — which local slot an inbound envelope is written to.
 *
 * Both rules have caused a shipped bug, which is why they are worth pinning
 * separately from the 900-line handler they came out of.
 */

const PEER = 'peer-uuid';

describe('S3 — routeInboundEnvelope', () => {
  it('adopts the sender-stamped group id VERBATIM', () => {
    // This is the B-124 seam: a REMOTE device names a LOCAL slot. Containment
    // lives downstream (isDeviceLocalGroupId, groupConversationUpsert) —
    // rejecting the id here would fail every re-escalated call at the joiner's
    // key gate, which was tried and rejected. Pinned so nobody "hardens" it.
    const r = routeInboundEnvelope({
      groupId: 'g-abc', peerUserId: PEER, resolveDirect: () => 'should-not-be-called',
    });
    expect(r.conversationId).toBe('g-abc');
    expect(r.via).toBe('group');
  });

  it('still adopts a device-local-shaped group id (containment is downstream)', () => {
    const r = routeInboundEnvelope({
      groupId: `direct:${PEER}`, peerUserId: PEER, resolveDirect: () => 'unused',
    });
    expect(r.conversationId).toBe(`direct:${PEER}`);
  });

  it('does not consult the direct resolver at all for a group envelope', () => {
    const resolveDirect = jest.fn(() => 'uuid-row');
    routeInboundEnvelope({groupId: 'g-1', peerUserId: PEER, resolveDirect});
    expect(resolveDirect).not.toHaveBeenCalled();
  });

  it('routes a 1:1 through the SHARED resolver, not the raw direct: key', () => {
    // A 1:1 can live in two slots (synthetic `direct:` and a server-UUID row).
    // ChatScreen subscribes to whichever the user tapped, so writing to the raw
    // synthetic key loses the bubble silently — typing still renders because it
    // fans out, the message does not. That was the Pixel v1.0.38 field bug.
    const r = routeInboundEnvelope({
      peerUserId: PEER, resolveDirect: uid => `uuid-for-${uid}`,
    });
    expect(r.conversationId).toBe(`uuid-for-${PEER}`);
    expect(r.conversationId).not.toBe(`direct:${PEER}`);
    expect(r.via).toBe('direct');
  });

  it('passes the peer id through to the resolver unchanged', () => {
    const resolveDirect = jest.fn(() => 'x');
    routeInboundEnvelope({peerUserId: PEER, resolveDirect});
    expect(resolveDirect).toHaveBeenCalledWith(PEER);
  });

  it('treats an EMPTY group id as absent — falls back to the direct resolver', () => {
    // An empty string must not be adopted as a slot name.
    const r = routeInboundEnvelope({
      groupId: '', peerUserId: PEER, resolveDirect: () => 'uuid-row',
    });
    expect(r.conversationId).toBe('uuid-row');
    expect(r.via).toBe('direct');
  });
});
