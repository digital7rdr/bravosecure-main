import {pruneCallKeyContamination} from '@/modules/messenger/store/messengerStore';

/**
 * B-124/B-125 — boot-time healing for devices contaminated BEFORE the
 * topology fix shipped. The code fix stops new contamination; this sweep
 * removes the persisted wreckage (call-key aliases on chat ids + the
 * impossible `direct:<self>` duplicate thread), which no existing prune
 * could reach.
 *
 * The dangerous cases are the NEGATIVE ones — a sweep that also deletes a
 * real conversation is far worse than the bug. Those are pinned first.
 */

const OWN = 'user-own';
const ALICE = 'user-alice';

type State = Parameters<typeof pruneCallKeyContamination>[0];

function state(over: Partial<State> = {}): State {
  return {
    conversations: {},
    conversationOrder: [],
    groups: {},
    _ownUserId: OWN,
    ...over,
  } as State;
}

describe('pruneCallKeyContamination — must NOT delete real data', () => {
  it('keeps a real group whose GroupState is named "Call" (non-direct id)', () => {
    // A user CAN name a real group "Call". Only direct-shaped ids are aliases.
    const s = state({
      groups: {'3f9a2b': {name: 'Call'}} as unknown as State['groups'],
      conversations: {'3f9a2b': {id: '3f9a2b', type: 'group'}} as unknown as State['conversations'],
      conversationOrder: ['3f9a2b'],
    });
    const out = pruneCallKeyContamination(s);
    expect(out.aliases).toBe(0);
    expect(s.groups['3f9a2b']).toBeDefined();
    expect(s.conversations['3f9a2b']).toBeDefined();
  });

  it('keeps a real group whose id is a server UUID', () => {
    const s = state({
      groups: {'8b1d-4e2a-11ef': {name: 'Ops Room'}} as unknown as State['groups'],
    });
    pruneCallKeyContamination(s);
    expect(s.groups['8b1d-4e2a-11ef']).toBeDefined();
  });

  it('KEEPS a legitimate cold-contact 1:1 that had a call escalated on it', () => {
    // The `:4442-4443` alias targets the ORIGINATING conversation — a real
    // chat. A cold-contact row legitimately has participants: [peer], so a
    // "has a Call alias and <= 1 participant" rule would destroy it.
    // Removing the alias is enough to un-break the chat; the row must stay.
    const s = state({
      conversations: {
        [`direct:${ALICE}`]: {id: `direct:${ALICE}`, type: 'direct', participants: [ALICE]},
      } as unknown as State['conversations'],
      conversationOrder: [`direct:${ALICE}`],
      groups: {[`direct:${ALICE}`]: {name: 'Call'}} as unknown as State['groups'],
    });
    const out = pruneCallKeyContamination(s);

    expect(out.aliases).toBe(1);                                  // alias cleared
    expect(s.groups[`direct:${ALICE}`]).toBeUndefined();
    expect(out.rows).toBe(0);                                     // row untouched
    expect(s.conversations[`direct:${ALICE}`]).toBeDefined();
    expect(s.conversationOrder).toEqual([`direct:${ALICE}`]);
  });

  it('is a no-op on a clean store', () => {
    const s = state({
      conversations: {
        [`direct:${ALICE}`]: {id: `direct:${ALICE}`, type: 'direct', participants: [OWN, ALICE]},
      } as unknown as State['conversations'],
      conversationOrder: [`direct:${ALICE}`],
      groups: {},
    });
    expect(pruneCallKeyContamination(s)).toEqual({aliases: 0, rows: 0});
    expect(s.conversations[`direct:${ALICE}`]).toBeDefined();
  });

  it('does not throw when the owner is unknown (pre-login rehydrate)', () => {
    const s = state({
      _ownUserId: null,
      conversations: {[`direct:${OWN}`]: {id: `direct:${OWN}`, type: 'direct'}} as unknown as State['conversations'],
    });
    const out = pruneCallKeyContamination(s);
    expect(out.rows).toBe(0);                 // cannot identify a self-slot without an owner
    expect(s.conversations[`direct:${OWN}`]).toBeDefined();
  });
});

describe('pruneCallKeyContamination — heals the contamination', () => {
  it('removes the `direct:<own userId>` alias (the :4434 write)', () => {
    const s = state({groups: {[`direct:${OWN}`]: {name: 'Call'}} as unknown as State['groups']});
    expect(pruneCallKeyContamination(s).aliases).toBe(1);
    expect(s.groups[`direct:${OWN}`]).toBeUndefined();
  });

  it('removes the `direct:<self>` ghost row and its order entry', () => {
    const s = state({
      conversations: {
        [`direct:${OWN}`]: {id: `direct:${OWN}`, type: 'direct', participants: [OWN], name: 'Bravo · a1b2c3d4'},
        [`direct:${ALICE}`]: {id: `direct:${ALICE}`, type: 'direct', participants: [OWN, ALICE]},
      } as unknown as State['conversations'],
      conversationOrder: [`direct:${OWN}`, `direct:${ALICE}`],
      groups: {[`direct:${OWN}`]: {name: 'Call'}} as unknown as State['groups'],
    });
    const out = pruneCallKeyContamination(s);

    expect(out).toEqual({aliases: 1, rows: 1});
    expect(s.conversations[`direct:${OWN}`]).toBeUndefined();
    expect(s.conversationOrder).toEqual([`direct:${ALICE}`]);
    expect(s.conversations[`direct:${ALICE}`]).toBeDefined();     // the real chat survives
  });

  it('clears BOTH aliases from a full B-124 device state in one pass', () => {
    // :4434 -> direct:<self>, :4442-4443 -> the originating 1:1.
    const s = state({
      conversations: {
        [`direct:${OWN}`]:   {id: `direct:${OWN}`, type: 'direct', participants: [OWN]},
        [`direct:${ALICE}`]: {id: `direct:${ALICE}`, type: 'direct', participants: [OWN, ALICE]},
      } as unknown as State['conversations'],
      conversationOrder: [`direct:${OWN}`, `direct:${ALICE}`],
      groups: {
        [`direct:${OWN}`]:   {name: 'Call'},
        [`direct:${ALICE}`]: {name: 'Call'},
        '3f9a2b':            {name: 'Call'},   // the minted 32-hex carrier — not a chat id
      } as unknown as State['groups'],
    });
    const out = pruneCallKeyContamination(s);

    expect(out).toEqual({aliases: 2, rows: 1});
    expect(s.groups[`direct:${OWN}`]).toBeUndefined();
    expect(s.groups[`direct:${ALICE}`]).toBeUndefined();
    expect(s.groups['3f9a2b']).toBeDefined();                     // harmless, left alone
    expect(s.conversations[`direct:${ALICE}`]).toBeDefined();     // real chat un-broken, kept
  });

  it('leaves a user-renamed call group alias alone (exact sentinel only)', () => {
    const s = state({groups: {[`direct:${OWN}`]: {name: 'Call + Alice'}} as unknown as State['groups']});
    expect(pruneCallKeyContamination(s).aliases).toBe(0);
    expect(s.groups[`direct:${OWN}`]).toBeDefined();
  });
});
