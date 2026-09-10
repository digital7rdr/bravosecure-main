/**
 * B-257 / B-258 — "answering a call from the notification fails or cuts the
 * call", and "tapping a message notification opens Choose Dashboard instead of
 * the chat".
 *
 * ONE cause. Every push deep-link hard-coded `Main -> MessengerTab -> X`.
 * `MessengerTab` exists only in the CLIENT tab shell; MainNavigator mounts
 * exactly one shell per account kind and returns CpoNavigator or AgentNavigator
 * BEFORE reaching those tabs. React Navigation drops an unresolvable navigate
 * silently, so for a CPO or agency account the tap did nothing and the user was
 * left on the product gate — "Choose Dashboard".
 *
 * For a message that is an annoyance. For a CALL it is fatal: the accept runs
 * inside CallScreen, so if that screen never mounts nobody ever answers and the
 * caller rings out. Answering from a notification was broken for every CPO and
 * agency account.
 *
 * The routes were never missing — they sit at three different paths. This table
 * is the fix, and it is asserted here because the device matrix for "answer a
 * call from a notification as a CPO" is expensive and this is the part that was
 * wrong.
 */
import {messengerRouteFor} from '../messengerDeepLink';

const CLIENT = {accountKind: 'individual' as const};
const AGENCY = {accountKind: 'agency' as const};
const CPO = {accountKind: 'cpo' as const, membershipStatus: 'active'};

const CALL_PARAMS = {callId: 'c1', callType: 'voice', isIncoming: true};

describe('the three-shell route table', () => {
  it('CLIENT nests through Main -> MessengerTab', () => {
    expect(messengerRouteFor('CallScreen', CALL_PARAMS, CLIENT)).toEqual({
      name: 'Main',
      params: {screen: 'MessengerTab', params: {screen: 'CallScreen', params: CALL_PARAMS}},
    });
  });

  it('AGENCY navigates the route DIRECTLY — AgentNavigator has no MessengerTab', () => {
    expect(messengerRouteFor('CallScreen', CALL_PARAMS, AGENCY)).toEqual({
      name: 'CallScreen',
      params: CALL_PARAMS,
    });
  });

  it('CPO nests through CpoTabs -> CpoComms', () => {
    // CpoNavigator mounts MessengerNavigator as the CpoComms tab.
    expect(messengerRouteFor('CallScreen', CALL_PARAMS, CPO)).toEqual({
      name: 'CpoTabs',
      params: {screen: 'CpoComms', params: {screen: 'CallScreen', params: CALL_PARAMS}},
    });
  });

  it('NO shell is sent to Main -> MessengerTab unless it actually has it', () => {
    // The one assertion that would have caught the bug.
    for (const shell of [AGENCY, CPO]) {
      const r = messengerRouteFor('CallScreen', CALL_PARAMS, shell);
      expect(JSON.stringify(r)).not.toContain('MessengerTab');
    }
  });
});

/**
 * Client review vs2 item 16 — the incident wake must open the incident.
 *
 * These live here, in the per-shell table, because the FIRST implementation put
 * them in a `departmentalEntry` ladder instead. Those ladders walk `getParent()`
 * from the navigation object they are given, and a push hands them the
 * container REF — which has no parent and reports only the ROOT state. Every
 * branch except the client-only `MessengerTab` one was therefore unreachable,
 * so an agency manager or a CPO tapping "incident reported" went nowhere at
 * all: exactly the B-258 class this file was written for, on the two personas
 * the feature is for. It had no test, which is why it shipped.
 */
describe('vs2 item 16 — incident targets resolve in every shell', () => {
  const INC = {incidentId: 'inc-1'};

  /**
   * UI corrections 2026-08-15 item 09 — an IncidentDetail wake now SEEDS THE
   * QUEUE UNDERNEATH ITSELF.
   *
   * The Incident tab used to root at IncidentQueue for a manager, so a push that
   * opened a detail had the queue below it and Back returned there. Item 09
   * moved that root to the report grid, which would have left a manager backing
   * out of an incident onto a blank category form.
   *
   * A screen+initial:false payload can only seed [initialRouteName, target] — it
   * cannot express "put IncidentQueue underneath". A nested state payload can,
   * so the DETAIL lane uses one while the other two targets keep the simpler
   * form. Both shapes are asserted, because the difference between them IS the
   * behaviour.
   */
  it('AGENCY reaches the Incident TAB, with the queue seeded under a detail', () => {
    expect(messengerRouteFor('IncidentDetail', INC, AGENCY, {initial: false})).toEqual({
      name: 'Departmental',
      params: {
        screen: 'Incident',
        params: {
          state: {
            index: 1,
            routes: [
              {name: 'IncidentQueue'},
              {name: 'IncidentDetail', params: INC},
            ],
          },
        },
      },
    });
  });

  it('a NON-detail incident target keeps the simple nesting', () => {
    // IncidentQueue and MyIncidents are their own destination — seeding a stack
    // under them would put a screen behind the one the user asked for.
    expect(messengerRouteFor('IncidentQueue', {}, AGENCY, {initial: false})).toEqual({
      name: 'Departmental',
      params: {screen: 'Incident', params: {screen: 'IncidentQueue', initial: false}},
    });
  });

  it('CPO reaches it through its own root Departmental route, NOT CpoComms', () => {
    // CpoComms is MessengerNavigator, which registers no incident screen.
    const r = messengerRouteFor('MyIncidents', {}, CPO, {initial: false});
    expect(r).toEqual({
      name: 'Departmental',
      params: {screen: 'Incident', params: {screen: 'MyIncidents', initial: false}},
    });
    expect(JSON.stringify(r)).not.toContain('CpoComms');
  });

  it('CLIENT keeps the extra MessengerTab hop', () => {
    expect(messengerRouteFor('MyIncidents', {}, CLIENT, {initial: false})).toEqual({
      name: 'Main',
      params: {
        screen: 'MessengerTab',
        params: {screen: 'Departmental', initial: false, params: {screen: 'Incident', params: {screen: 'MyIncidents', initial: false}}},
      },
    });
  });

  it('no shell degrades an incident target to MessengerHome', () => {
    // The agency fallback for an unregistered target is MessengerHome — which
    // for an incident wake would be the silent-drop-by-another-name.
    for (const shell of [AGENCY, CPO, CLIENT]) {
      for (const t of ['IncidentDetail', 'MyIncidents'] as const) {
        expect(JSON.stringify(messengerRouteFor(t, INC, shell))).toContain('Incident');
      }
    }
  });
});

describe('an unknown or half-known account falls back to the client path', () => {
  it('empty signals behave exactly like the old hard-coded code', () => {
    // A cold headless start has no auth store yet. Degrading to the path every
    // previous build used is strictly no worse than before.
    expect(messengerRouteFor('Chat', {conversationId: 'x'}, {}).name).toBe('Main');
  });

  it('a CPO whose membership is revoked is NOT sent to the CPO shell', () => {
    // resolveAuthedRoute sends them to access-ended; there is no CpoTabs
    // mounted, so the CPO nesting would be another dropped navigate.
    const r = messengerRouteFor('Chat', {conversationId: 'x'}, {
      accountKind: 'cpo', membershipStatus: 'suspended',
    });
    expect(r.name).not.toBe('CpoTabs');
  });

  it('an agency by LEGACY role resolves to the agency shell', () => {
    // pendingProvider / legacy role strings are the self-signup fallback that
    // resolveAuthedRoute folds in — the deep-link must agree with the shell.
    expect(messengerRouteFor('Chat', {conversationId: 'x'}, {legacyRole: 'service_provider'}).name)
      .toBe('Chat');
    expect(messengerRouteFor('Chat', {conversationId: 'x'}, {pendingProvider: true}).name)
      .toBe('Chat');
  });

  it('a CPO promoted to org manager follows the AGENCY shell, as MainNavigator does', () => {
    const r = messengerRouteFor('CallScreen', CALL_PARAMS, {
      accountKind: 'cpo', membershipStatus: 'active', isOrgManager: true,
    });
    expect(r.name).toBe('CallScreen');
  });
});

describe('B-85 — `initial: false` survives the indirection', () => {
  it('is set on the nested leaf for the client shell', () => {
    const r = messengerRouteFor('Chat', {conversationId: 'x'}, CLIENT, {initial: false});
    expect(r.params).toEqual({
      screen: 'MessengerTab',
      params: {screen: 'Chat', initial: false, params: {conversationId: 'x'}},
    });
  });

  it('and for the CPO shell', () => {
    const r = messengerRouteFor('Chat', {conversationId: 'x'}, CPO, {initial: false});
    expect(JSON.stringify(r)).toContain('"initial":false');
  });

  it('is omitted when not asked for', () => {
    const r = messengerRouteFor('Chat', {conversationId: 'x'}, CLIENT);
    expect(JSON.stringify(r)).not.toContain('initial');
  });
});

describe('params are passed through untouched', () => {
  it('an EMPTY params object is omitted, never sent as {}', () => {
    // RN6 navigate() REPLACES params, so `params: {}` is not inert — it would
    // clobber an already-mounted screen's params. It also keeps the emitted
    // action byte-identical to every pre-existing call site.
    expect(messengerRouteFor('CallsLog', {}, CLIENT)).toEqual({
      name: 'Main',
      params: {screen: 'MessengerTab', params: {screen: 'CallsLog'}},
    });
    expect(messengerRouteFor('MessengerHome', {}, AGENCY)).toEqual({
      name: 'MessengerHome',
      params: undefined,
    });
  });

  it('the full 7-key call contract reaches the leaf intact', () => {
    const full = {
      callType: 'video', isIncoming: true, conversationId: 'c',
      callId: 'id', remoteUserId: 'u', remoteDeviceId: 1, incomingSdp: 'sdp',
    };
    for (const shell of [CLIENT, AGENCY, CPO]) {
      expect(JSON.stringify(messengerRouteFor('CallScreen', full, shell)))
        .toContain('"incomingSdp":"sdp"');
    }
  });
});

describe('the agency shell routes registered targets directly, unknown ones degrade', () => {
  it('N2 — CallsLog is now registered in AgentNavigator, so route to it directly', () => {
    expect(messengerRouteFor('CallsLog', {}, AGENCY)).toEqual({
      name: 'CallsLog',
      params: undefined,
    });
  });

  it('an unregistered target still degrades to MessengerHome, never nowhere', () => {
    // Navigating to a route the shell lacks is precisely the class being fixed;
    // the fallback must be a screen that exists.
    expect(
      messengerRouteFor('UnregisteredFuture' as unknown as Parameters<typeof messengerRouteFor>[0], {}, AGENCY),
    ).toEqual({name: 'MessengerHome', params: undefined});
  });

  it('but the CPO shell keeps CallsLog — it nests the whole MessengerNavigator', () => {
    expect(messengerRouteFor('CallsLog', {}, CPO)).toEqual({
      name: 'CpoTabs',
      params: {screen: 'CpoComms', params: {screen: 'CallsLog'}},
    });
  });
});

describe('pins the navigator registrations this table encodes', () => {
  const {readFileSync} = require('node:fs') as typeof import('node:fs');
  const {join} = require('node:path') as typeof import('node:path');
  const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

  it('AgentNavigator hosts the messenger screens on its ROOT stack', () => {
    const agent = src('src/navigation/AgentNavigator.tsx');
    // N2 — CallsLog is now hosted here too, so the footer Call tap works in the
    // agency shell and its deep-link routes directly instead of degrading.
    for (const r of ['MessengerHome', 'Chat', 'CallScreen', 'GroupCallScreen', 'IncomingGroupCallScreen', 'CallsLog']) {
      expect(agent).toContain(`name="${r}"`);
    }
    expect(agent).not.toContain('name="MessengerTab"');
  });

  it('CpoNavigator reaches them through the CpoComms tab', () => {
    const cpo = src('src/navigation/CpoNavigator.tsx');
    expect(cpo).toMatch(/name="CpoTabs"/);
    expect(cpo).toMatch(/name="CpoComms" component=\{MessengerNavigator\}/);
  });

  it('MessengerTab exists ONLY in the client tab shell', () => {
    expect(src('src/navigation/MainNavigator.tsx')).toContain('name="MessengerTab"');
    expect(src('src/navigation/CpoNavigator.tsx')).not.toContain('MessengerTab');
  });
});

/**
 * A MISSING `isReady` is a screen navigation object, not a dead tree.
 *
 * `isReady` exists only on the NavigationContainer ref. The guard used to be
 * `if (!nav?.isReady?.()) return false`, so every caller passing a screen or
 * tab `navigation` — which cannot have that method — got a silent no-op that
 * typechecked cleanly, because `isReady?:` is declared optional.
 *
 * These are BEHAVIOURAL on purpose. Every pin over the affected call sites was
 * a source scan asserting the call was written, and a source scan cannot see
 * that the function returns before doing anything. Three sites were dead
 * (`openConversation`'s dept arm from three list screens, ActivityCenter's
 * incident rows, and the workspace Messenger exit) with every gate green.
 */
describe('navigateToMessengerScreen — readiness is about the CONTAINER, not the caller', () => {
  const {navigateToMessengerScreen} = require('../messengerDeepLink') as
    typeof import('../messengerDeepLink');

  it('navigates when handed a screen nav object with no isReady at all', () => {
    const navigate = jest.fn();
    const ok = navigateToMessengerScreen({navigate}, 'MessengerHome', {}, {initial: false});
    expect(ok).toBe(true);
    expect(navigate).toHaveBeenCalled();
  });

  it('still refuses a CONTAINER ref that reports not-ready', () => {
    // That check is real and must survive: the cold-boot push lane can fire
    // before the tree exists.
    const navigate = jest.fn();
    const ok = navigateToMessengerScreen(
      {navigate, isReady: () => false}, 'MessengerHome', {}, {initial: false});
    expect(ok).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates for a container ref that IS ready', () => {
    const navigate = jest.fn();
    const ok = navigateToMessengerScreen(
      {navigate, isReady: () => true}, 'MessengerHome', {}, {initial: false});
    expect(ok).toBe(true);
    expect(navigate).toHaveBeenCalled();
  });

  it('a null nav is still refused', () => {
    expect(navigateToMessengerScreen(null, 'MessengerHome', {}, {})).toBe(false);
  });
});
