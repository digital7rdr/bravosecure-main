/**
 * PDF item 08 — "Emergency Calls have not been added to Calls Log."
 *
 * The founder's ask, and the two things that make it harder than it sounds:
 *
 *   1. An emergency call is a `tel:` HAND-OFF. The OS never reports back, so
 *      the only honest moment to record anything is the instant we dial, and
 *      the only honest content is "this number, at this time". Any duration or
 *      answered/missed on such a row would be invented.
 *   2. Every other row in this screen is WebRTC-derived and its tap calls
 *      `launchCall({conversationId})`. An emergency row has no conversation, so
 *      sharing the row component would produce a tap that silently does nothing.
 *
 * Both are pinned below, because both are the kind of wrong that LOOKS right.
 */
import React from 'react';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {render, fireEvent, waitFor} from '@testing-library/react-native';

const mockOpenURL = jest.fn(() => Promise.resolve(true));
const mockAlert = jest.fn();
const mockLaunchCall = jest.fn();
let mockCountryIso: string | null = 'GB';
const mockNavigate = jest.fn();

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
// B-638 — the card derives its country from the phone's LOCALE. Pin it so the
// chip set is deterministic and the 'this is a guess' copy is assertable.
jest.mock('@screens/vbg/deviceCountry', () => ({getDeviceCountryIso: () => mockCountryIso}));
// The card's dialler-failed fallback goes through the app-wide alert queue.
jest.mock('@utils/alert', () => ({Alert: {alert: (...a: unknown[]) => mockAlert(...a)}}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: mockNavigate, goBack: jest.fn(), canGoBack: () => true}),
}));
jest.mock('@/modules/messenger/webrtc/launchCall', () => ({launchCall: (...a: unknown[]) => mockLaunchCall(...a)}));
jest.mock('@/modules/messenger/ui/UserAvatar', () => ({UserAvatar: 'UserAvatar'}));
// No WebRTC calls unless a test adds them, so the emergency rows stand alone.
let mockCallMessages: unknown[] = [];
jest.mock('@/modules/messenger/store', () => ({
  useMessengerStore: (sel: (s: unknown) => unknown) =>
    sel({messages: {}, conversations: {}}),
  selectCallMessages: () => mockCallMessages,
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
}));

import {Linking} from 'react-native';
jest.spyOn(Linking, 'openURL').mockImplementation(mockOpenURL as never);

import CallsLogScreen, {emergencyQuickDialChips} from '../CallsLogScreen';
import {useEmergencyCallLog, recordEmergencyCall} from '@store/emergencyCallLog';
import {EMERGENCY_NUMBERS, UNIVERSAL_EMERGENCY} from '@screens/vbg/emergencyNumbers';

const HOUR = 3_600_000;

beforeEach(() => {
  jest.clearAllMocks();
  mockCallMessages = [];
  mockCountryIso = 'GB';
  useEmergencyCallLog.setState({records: []});
});

describe('the record itself', () => {
  it('stores what was dialled, and nothing it cannot know', () => {
    recordEmergencyCall({sanitised: '999', label: 'Police', source: 'directory', countryIso: 'GB'});
    const [r] = useEmergencyCallLog.getState().records;
    expect(r).toEqual(expect.objectContaining({
      number: '999', label: 'Police', source: 'directory', countryIso: 'GB',
    }));
    // The two fields a WebRTC row has and this one must NOT invent.
    expect(r).not.toHaveProperty('duration');
    expect(r).not.toHaveProperty('outcome');
  });

  it('dedupes a double-tap, because the dialler takes a moment to foreground', () => {
    // Real behaviour: the user taps, nothing appears to happen, they tap again.
    // Two rows for one call is a worse log than one.
    recordEmergencyCall({sanitised: '999', label: 'Police', source: 'directory'});
    recordEmergencyCall({sanitised: '999', label: 'Police', source: 'directory'});
    expect(useEmergencyCallLog.getState().records).toHaveLength(1);
  });

  it('…but a genuine call-back later is a SECOND record', () => {
    // The dedupe is a 15s window against the most recent entry only. Collapsing
    // on number alone would silently swallow a real second call.
    recordEmergencyCall({sanitised: '999', source: 'directory'});
    const first = useEmergencyCallLog.getState().records[0];
    useEmergencyCallLog.setState({records: [{...first, at: Date.now() - HOUR}]});
    recordEmergencyCall({sanitised: '999', source: 'directory'});
    expect(useEmergencyCallLog.getState().records).toHaveLength(2);
  });

  it('is bounded — a crisis can mean many taps', () => {
    for (let i = 0; i < 120; i++) {
      useEmergencyCallLog.getState().record({number: `${i}`, source: 'directory', at: Date.now() + i});
    }
    expect(useEmergencyCallLog.getState().records.length).toBeLessThanOrEqual(100);
  });
});

describe('the Calls Log row', () => {
  const seed = (over: Record<string, unknown> = {}) =>
    useEmergencyCallLog.setState({records: [{
      id: 'em-1', number: '999', label: 'Police', source: 'directory', at: Date.now(), ...over,
    }]});

  it('appears in the log, visually identifiable', () => {
    // The founder asked for both halves: it must APPEAR, and it must be
    // distinguishable from ordinary call history.
    seed();
    const u = render(<CallsLogScreen />);
    expect(u.getByText('Police')).toBeTruthy();
    expect(u.getByText('EMERGENCY')).toBeTruthy();
  });

  it('shows the NUMBER as well as the label', () => {
    // "Police" does not say what was dialled, and after an incident the number
    // is the fact that matters.
    seed();
    const u = render(<CallsLogScreen />);
    expect(u.getByText(/Emergency services · 999/)).toBeTruthy();
  });

  it('falls back to the number when there was no label', () => {
    seed({label: undefined});
    const u = render(<CallsLogScreen />);
    expect(u.getAllByText(/999/).length).toBeGreaterThan(0);
  });

  it('RE-DIALS on tap — it never calls launchCall', () => {
    /**
     * THE DEFECT THE DISCRIMINATED UNION EXISTS TO PREVENT. Sharing the call
     * row would send this id to `launchCall({conversationId})`, which resolves
     * no peer and does nothing at all — a dead row in the one log someone
     * reaches for after an incident.
     */
    seed();
    const u = render(<CallsLogScreen />);
    fireEvent.press(u.getByLabelText(/Emergency call to Police/));
    expect(mockOpenURL).toHaveBeenCalledWith('tel:999');
    expect(mockLaunchCall).not.toHaveBeenCalled();
  });

  it('an immediate re-dial from the log does not create a second row', () => {
    // The re-dial IS recorded (calling the police again is a real second
    // call), so what keeps this at one row is the store's 15s dedupe — not
    // an exception for this screen. An exception is how the next dial site
    // quietly goes unlogged.
    seed();
    const u = render(<CallsLogScreen />);
    fireEvent.press(u.getByLabelText(/Emergency call to Police/));
    expect(useEmergencyCallLog.getState().records).toHaveLength(1);
  });
});

describe('which filters it belongs to', () => {
  beforeEach(() => useEmergencyCallLog.setState({records: [
    {id: 'em-1', number: '999', label: 'Police', source: 'directory', at: Date.now()},
  ]}));

  it('is under All and Voice — it IS a voice call', () => {
    const u = render(<CallsLogScreen />);
    expect(u.getByText('EMERGENCY')).toBeTruthy();      // All is the default
    fireEvent.press(u.getByText('Voice'));
    expect(u.getByText('EMERGENCY')).toBeTruthy();
  });

  it('is NOT under Missed or Video — both would be a claim we cannot make', () => {
    // The OS never tells us whether it was answered, and it is not video.
    // Showing it under either would be inventing an outcome.
    const u = render(<CallsLogScreen />);
    fireEvent.press(u.getByText('Missed'));
    expect(u.queryByText('EMERGENCY')).toBeNull();
    fireEvent.press(u.getByText('Video'));
    expect(u.queryByText('EMERGENCY')).toBeNull();
  });
});

/**
 * Client 2026-08-22 — emergency services is a HEADER DOOR, not a card.
 *
 * The first cut pinned a quick-dial card above the rows. The founder asked for
 * the lighter shape already used by "Links": a menu entry that opens the full
 * Emergency Services page (every country + search) that Virtual Bodyguard has.
 * So the card is GONE and this is what replaces it — asserted by rendering,
 * because "the door exists" is exactly what a scan cannot prove.
 */
/**
 * B-638 (client, 2026-08-23) — REVERSES the B-626 block above.
 *
 * The client's screenshot of what they want shows the CARD back, and **no
 * emergency word in the header at all** — so the card replaces that door rather
 * than sitting beside it. LINKS is removed too, by explicit instruction ("just
 * remove the button"); its route stays registered, so restoring a door
 * elsewhere is a one-line change.
 *
 * The three assertions below are the inverses of the three B-626 ones, kept
 * rather than deleted so the reversal is legible to whoever reads this next.
 */
describe('the Emergency card (client 2026-08-23, B-638)', () => {


  it('pins the card, with no call history required', () => {
    useEmergencyCallLog.setState({records: []});
    const u = render(<CallsLogScreen />);
    expect(u.getByText('EMERGENCY CALLS')).toBeTruthy();
    // …and the B-626 header word is gone: the card IS the door now.
    expect(u.queryByLabelText('Emergency services')).toBeNull();
  });

  it('opens the full Emergency Services page from the card header', () => {
    const u = render(<CallsLogScreen />);
    fireEvent.press(u.getByLabelText(/^Emergency services\./));
    expect(mockNavigate).toHaveBeenCalledWith('EmergencyServices');
  });

  it('REMOVES the Links button (B-638) — the route stays registered', () => {
    const u = render(<CallsLogScreen />);
    expect(u.queryByLabelText('Show links shared in chats')).toBeNull();
  });

  /**
   * 2026-08-24, founder call — the banner is chevron-only: one calm
   * affordance whose single job is opening the directory. The quick-dial
   * chips (and with them the locale-guessed country line) are gone from the
   * card; dialling lives in the directory's country cards, where the country
   * is VISIBLE at dial time, and in the log rows below.
   */
  it('is the chevron-only banner — no quick-dial chips, no locale-guessed country', () => {
    const u = render(<CallsLogScreen />);
    expect(u.getByText(/Reach emergency services/)).toBeTruthy();
    expect(u.queryByText(/from your phone's language/)).toBeNull();
    expect(u.queryByLabelText(/^Call /)).toBeNull();          // no dial chips
    expect(u.queryByText('All countries')).toBeNull();        // the whole card is the door
  });

  /**
   * ⛔ THE ORDERING PIN — record BEFORE dial, kept alive on the LOG ROW now
   * that the chips are gone (`emergencyDialSites.test.ts` only checks both
   * tokens appear in the file, so swapping the statements is caught by
   * nothing else). Driven with a REJECTING `openURL`, which is the case the
   * order exists for: the attempt must be logged even when the dialler never
   * launches.
   */
  it('the log row records the re-dial attempt BEFORE handing off, even when the dialler fails', async () => {
    useEmergencyCallLog.setState({records: [{
      id: 'em-1', number: '999', label: 'Police', source: 'directory', at: Date.now() - 60_000,
    }]});
    mockOpenURL.mockRejectedValueOnce(new Error('no activity found'));
    const u = render(<CallsLogScreen />);
    fireEvent.press(u.getByLabelText(/Emergency call to Police/));
    // Recorded synchronously, before the promise could reject (the 15s dedupe
    // window has passed, so this re-dial is a genuine second record).
    expect(useEmergencyCallLog.getState().records.length).toBe(2);
    await waitFor(() => expect(mockAlert).toHaveBeenCalled());
    // …and the user is told the number rather than left with a dead tap.
    expect(String(mockAlert.mock.calls[0]?.[1] ?? '')).toContain('999');
  });
});

/**
 * B-638 — the card's POSITION, which no render test can see.
 *
 * The spec decided the card is pinned between the header and the filter tabs,
 * OUTSIDE the ScrollView: an emergency door that scrolls off-screen is the one
 * affordance that must never need a scroll to find. RTL renders the whole tree
 * regardless of scroll position, so `getByText` proves nothing about this — a
 * source scan is the only gate. Comment-stripped and `\r?\n` split per the
 * house rules (this file is CRLF).
 */
describe('B-638 — the card is PINNED, not scrolled', () => {
  const src = readFileSync(
    join(process.cwd(), 'src', 'screens', 'messenger', 'CallsLogScreen.tsx'), 'utf8',
  ).split(/\r?\n/).filter(l => {
    const t = l.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
  }).join('\n');

  it('renders above the filter tabs and before the scroller opens', () => {
    // B-655 RE-POINTED, not weakened: the list became a virtualised `FlatList`
    // (callsLogVirtualized.test.ts), so the old `<ScrollView` anchor resolved to
    // -1 and this assertion would have passed vacuously in the other direction.
    // The INVARIANT is unchanged — the emergency card is outside the scroller,
    // so it never needs a scroll to reach.
    const card = src.indexOf('<EmergencyQuickDial');
    const tabs = src.indexOf('styles.tabRow');
    const scroll = src.indexOf('<FlatList');
    expect(card).toBeGreaterThan(-1);
    expect(scroll).toBeGreaterThan(-1);  // guards against a vacuous -1 compare
    expect(card).toBeLessThan(tabs);     // above the filters
    expect(card).toBeLessThan(scroll);   // and outside the scroller
  });

  it('is UNCONDITIONAL — it must render in the embedded Calls tab too', () => {
    // The founder reaches Calls through the embedded tab, not the pushed screen.
    // Gating the card on `!embedded` would hide it exactly there.
    const at = src.indexOf('<EmergencyQuickDial');
    const line = src.slice(src.lastIndexOf('\n', at) + 1, src.indexOf('\n', at));
    expect(line).not.toContain('embedded');
    expect(line).not.toContain('&&');
  });
});

describe('B-638 — emergencyQuickDialChips', () => {
  /**
   * ⚠️ THIS ASSERTION WAS REVERSED IN REVIEW, and the reasoning matters.
   *
   * v1 always emphasised 112, arguing the country is only a guess. That is
   * right when the guess FAILS and wrong when it succeeds: on a correctly
   * detected US phone it made 112 the big red button and de-emphasised 911 —
   * the number that is official, guaranteed and location-routed there.
   *
   * The rule now: emphasise the country's OWN number when we have one, and 112
   * when we do not. 112 is always PRESENT either way.
   */
  it('emphasises the COUNTRY\'S number, not 112, when the country is known', () => {
    const gb = emergencyQuickDialChips({iso: 'GB', name: 'United Kingdom', all: '999'});
    expect(gb.find(c => c.strong)?.number).toBe('999');
    expect(gb.some(c => c.number === '112')).toBe(true); // …but always reachable
    expect(gb.filter(c => c.strong)).toHaveLength(1);

    const us = emergencyQuickDialChips({iso: 'US', name: 'United States', all: '911'});
    expect(us.find(c => c.strong)?.number).toBe('911');
  });

  it('falls back to emphasising 112 when the country is unknown', () => {
    expect(emergencyQuickDialChips(null).find(c => c.strong)?.number).toBe('112');
  });

  it('MERGES service labels onto a shared number instead of deleting them', () => {
    // Ireland: all=112, police/ambulance/fire=999. A plain dedupe showed someone
    // who needs an ambulance a button labelled "Police"; Japan lost "Fire".
    const ie = emergencyQuickDialChips({
      iso: 'IE', name: 'Ireland', all: '112', police: '999', ambulance: '999', fire: '999',
    });
    expect(ie.map(c => c.label)).toEqual(['All services', 'Police / Ambulance / Fire']);
  });

  it('sanitises at CONSTRUCTION, so the chip, the tel: intent and the log agree', () => {
    const chips = emergencyQuickDialChips({iso: 'XX', name: 'Example', police: '0900-8844'});
    expect(chips[0].number).toBe('09008844');
  });

  /**
   * A property test over the REAL directory — the earlier version checked GB
   * alone, so an invariant that held for one country was being sold as general.
   */
  it('holds across every country in the shipped directory', () => {
    for (const entry of EMERGENCY_NUMBERS) {
      const chips = emergencyQuickDialChips(entry);
      expect(chips.filter(c => c.strong)).toHaveLength(1);           // never 0, never 2
      expect(chips.some(c => c.number === UNIVERSAL_EMERGENCY)).toBe(true); // 112 always reachable
      expect(new Set(chips.map(c => c.number)).size).toBe(chips.length);    // no duplicate numbers
      for (const c of chips) {
        expect(c.number).toMatch(/^[\d+*#]+$/); // already dial-safe
      }
    }
  });

  it('DEDUPES by number — Bangladesh is 999 for all four services', () => {
    const chips = emergencyQuickDialChips({
      iso: 'BD', name: 'Bangladesh', all: '999', police: '999', ambulance: '999', fire: '999',
    });
    expect(chips.map(c => c.number)).toEqual(['999', '112']);
  });

  it('collapses to the universal number alone when the locale names no country', () => {
    const chips = emergencyQuickDialChips(null);
    expect(chips).toEqual([{label: 'Universal', number: '112', strong: true}]);
  });

  it('keeps distinct per-service numbers', () => {
    const chips = emergencyQuickDialChips({
      iso: 'XX', name: 'Example', police: '101', ambulance: '102', fire: '103',
    });
    expect(chips.map(c => c.number)).toEqual(['101', '102', '103', '112']);
  });
});
