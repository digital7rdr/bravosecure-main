/**
 * F4 — a department-channel notification tap opened ChatScreen, which renders
 * phone + video buttons unconditionally. The PDF's A9/M9 rule is locked: "No
 * phone/call button appears in Department Channel chat; calls remain in
 * Messenger." A channel's conversation is stored with `type: 'group'`, so
 * `fcmBootstrap`'s `isGroup = conv.type === 'group'` could not tell it from an
 * ordinary group and every channel push landed on the banned surface.
 *
 * This file pins the NAVIGATION half:
 *   - the dept-vs-group signal itself (`resolveDeptConversation`), including the
 *     case the naive fix misses — a channel whose pointer row was never written
 *     on this device;
 *   - the three-shell path table for the two new targets, where the AGENCY shell
 *     is the one that used to silently degrade (AgentNavigator registers
 *     `Departmental` and nothing inside it);
 *   - the decision site in `fcmBootstrap`'s msg-wake branch, because no unit
 *     test in this project can import that module.
 *
 * The behavioural half (drive the real notifee handler, seeded store, cold-boot
 * persisted slice) is `src/modules/messenger/__tests__/deptChannelNotifTap.test.ts`.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {messengerRouteFor} from '../messengerDeepLink';
import {resolveDeptConversation} from '@/modules/messenger/push/deptChannelTarget';

const CLIENT = {accountKind: 'client'};
const AGENCY = {accountKind: 'agency'};
const CPO    = {accountKind: 'cpo'};

const CHAT_PARAMS = {
  channelId:           'ch-9',
  channelName:         'Operations',
  channelDesc:         '',
  groupConversationId: 'conv-9',
};

describe('resolveDeptConversation — the dept-vs-group signal', () => {
  it('returns the channel id when the pointer map knows this conversation', () => {
    expect(resolveDeptConversation('conv-9', {
      deptGroupByChannel: {'ch-9': 'conv-9'},
      deptConversationIds: {'conv-9': true},
    })).toEqual({channelId: 'ch-9', orgId: null});
  });

  /**
   * THE CASE A NAIVE FIX MISSES. `deptGroupByChannel` is written when a channel
   * thread is opened, and B-206 OVERWRITES it on a remap. `deptConversationIds`
   * is the additive registry `armDeptConversationRegistry()` fills from the
   * server at every messenger boot — so on a device that has never opened the
   * channel, the pointer is absent and only the registry answers. Reading the
   * pointer alone would route that tap to ChatScreen: the whole bug.
   */
  it('still reports DEPARTMENTAL when only the additive registry knows it', () => {
    expect(resolveDeptConversation('conv-9', {deptConversationIds: {'conv-9': true}}))
      .toEqual({channelId: null, orgId: null});
  });

  it('is null for an ordinary group — that tap keeps its Chat routing', () => {
    expect(resolveDeptConversation('g-1', {
      deptGroupByChannel: {'ch-9': 'conv-9'},
      deptConversationIds: {'conv-9': true},
    })).toBeNull();
  });

  it('is null (never a throw) with absent/empty maps or a blank id', () => {
    expect(resolveDeptConversation('conv-9', {})).toBeNull();
    expect(resolveDeptConversation('conv-9', null)).toBeNull();
    expect(resolveDeptConversation('', {deptConversationIds: {'': true} as never})).toBeNull();
  });
});

describe('messengerRouteFor — where DepartmentChat lives in each shell', () => {
  it('CLIENT: Main -> MessengerTab -> DepartmentChat, initial:false', () => {
    expect(messengerRouteFor('DepartmentChat', CHAT_PARAMS, CLIENT, {initial: false})).toEqual({
      name:   'Main',
      params: {screen: 'MessengerTab', params: {screen: 'DepartmentChat', initial: false, params: CHAT_PARAMS}},
    });
  });

  it('CPO: CpoTabs -> CpoComms -> DepartmentChat', () => {
    expect(messengerRouteFor('DepartmentChat', CHAT_PARAMS, CPO, {initial: false})).toEqual({
      name:   'CpoTabs',
      params: {screen: 'CpoComms', params: {screen: 'DepartmentChat', initial: false, params: CHAT_PARAMS}},
    });
  });

  /**
   * THE AGENCY DEGRADE. AgentNavigator registers `Departmental` and nothing
   * inside it, so the pre-existing "not on the agency root -> MessengerHome"
   * rule would drop an agency owner (a persona who is in every channel) on the
   * chat list instead of the post they tapped.
   */
  it('AGENCY: Departmental -> Channels -> DepartmentChat, never MessengerHome', () => {
    const route = messengerRouteFor('DepartmentChat', CHAT_PARAMS, AGENCY, {initial: false});
    expect(route).toEqual({
      name:   'Departmental',
      params: {screen: 'Channels', params: {screen: 'DepartmentChat', initial: false, params: CHAT_PARAMS}},
    });
    expect(route.name).not.toBe('MessengerHome');
  });

  it('AGENCY: the directory degrade lands in the workspace too', () => {
    expect(messengerRouteFor('DepartmentChannels', {}, AGENCY, {initial: false})).toEqual({
      name:   'Departmental',
      params: {screen: 'Channels', params: {screen: 'DepartmentChannels', initial: false}},
    });
  });

  it('CLIENT: the directory degrade is the messenger tab route', () => {
    expect(messengerRouteFor('DepartmentChannels', {}, CLIENT, {initial: false})).toEqual({
      name:   'Main',
      params: {screen: 'MessengerTab', params: {screen: 'DepartmentChannels', initial: false}},
    });
  });

  it('leaves every pre-existing target routed exactly as before', () => {
    // Regression guard on the shared table: the agency branch grew a second
    // arm, and a mis-scoped condition there would silently re-route calls.
    expect(messengerRouteFor('CallScreen', {callId: 'c1'}, AGENCY)).toEqual({
      name: 'CallScreen', params: {callId: 'c1'},
    });
    // N2 — CallsLog is now registered in AgentNavigator, so it routes directly
    // in the agency shell instead of degrading to MessengerHome.
    expect(messengerRouteFor('CallsLog', {}, AGENCY)).toEqual({name: 'CallsLog', params: undefined});
    expect(messengerRouteFor('Chat', {conversationId: 'c'}, CLIENT)).toEqual({
      name: 'Main', params: {screen: 'MessengerTab', params: {screen: 'Chat', params: {conversationId: 'c'}}},
    });
  });
});

/**
 * The decision site. `fcmBootstrap.ts` transitively imports react-native +
 * firebase, so this project scans it as TEXT (same pattern as
 * pushNavigateParamSweep). Comments are stripped first, and the assertions are
 * scoped to the BALANCED msg-wake branch — a file-wide "no 'Chat'" scan would be
 * both wrong (the missed-call handler legitimately opens Chat) and worthless.
 */
describe('fcmBootstrap msg-wake branch routes through the one door', () => {
  const src = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts'), 'utf8',
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');   // [^\n] also eats the trailing \r — CRLF-safe

  function balancedFrom(idx: number): string {
    const open = code.indexOf('{', idx);
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') {depth++;}
      else if (code[i] === '}') { depth--; if (depth === 0) {return code.slice(open, i + 1);} }
    }
    throw new Error('unbalanced msg-wake branch');
  }

  const branchIdx = code.indexOf("if (data.kind === 'msg-wake')");
  const branch = balancedFrom(branchIdx);

  it('the msg-wake branch exists and was actually found', () => {
    expect(branchIdx).toBeGreaterThan(-1);
    // Non-vacuous: the slice must contain the branch's own landmarks.
    expect(branch).toMatch(/resolveDeptRouteForTap\(/);
    expect(branch).toMatch(/navigateToThread\(/);
  });

  it('NO navigate inside it hard-codes the Chat screen any more', () => {
    // This is the mutation the fix undoes: `navigateToMessengerScreen(nav,
    // 'Chat', …)` at either navigate site sends a channel post to the surface
    // with the banned call buttons. Scoped to the CALL — `current.name ===
    // 'Chat'` (the B-324 "is the user still where I put them" read) is a
    // different use of the same token and must survive.
    expect(branch).not.toMatch(/navigateToMessengerScreen\([^,]+,\s*'Chat'/);
    // MessengerHome (the unresolvable-conversation degrade) is the only screen
    // this branch is still allowed to name directly.
    const direct = branch.match(/navigateToMessengerScreen\([^,]+,\s*'([A-Za-z]+)'/g) ?? [];
    expect(direct.every(m => m.endsWith("'MessengerHome'"))).toBe(true);
  });

  it('BOTH navigate sites go through it — the immediate one and the B-324 re-route', () => {
    expect(branch.match(/navigateToThread\(/g)).toHaveLength(2);
    // …and the re-route resolves department-ness for ITS target, not the
    // banner's (they can be different conversations).
    expect(branch.match(/resolveDeptRouteForTap\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('the one door reads the channel id before choosing DepartmentChat', () => {
    // From `): void {`, not the first `{` — the signature's own type literals
    // would otherwise be mistaken for the body.
    const door = balancedFrom(code.indexOf('): void {', code.indexOf('function navigateToThread')));
    expect(door).toMatch(/dept\?\.channelId/);
    expect(door).toMatch(/'DepartmentChat'/);
    // The dept-but-unmapped degrade is the DIRECTORY, never Chat.
    expect(door).toMatch(/'DepartmentChannels'/);
  });
});
