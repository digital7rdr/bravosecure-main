/**
 * B-703 MR-11 — `activeConversationId` must mean "the user is looking at this
 * thread RIGHT NOW", because three systems silence a thread on the strength of
 * it: the background notifier withholds its banner, the store withholds the
 * unread bump, and the in-app banner layer hides itself.
 *
 * The two lanes that left it lying, both reported as "no notification":
 *   (a) push contact-info / settings / a call screen OVER a chat — the old pin
 *       was MOUNT-scoped, so the chat underneath stayed "active";
 *   (b) press Home from inside a chat — nothing in navigation changes at all,
 *       so focus scoping alone does not cover it either.
 *
 * `useFocusEffect` is mocked here as a controllable focus, which is also what
 * makes the regression detectable: swap the hook back to a plain `useEffect`
 * and the blur case below stops clearing.
 */
import React from 'react';
import type * as ReactNS from 'react';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {render} from '@testing-library/react-native';
import {AppState} from 'react-native';

const mockFocusState = {focused: true};
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    const R = require('react') as typeof ReactNS;
    const focused = mockFocusState.focused;
    R.useEffect(() => {
      if (!focused) {return undefined;}
      return cb() as undefined;
    }, [cb, focused]);
  },
}));

import {useActiveConversation} from '../useActiveConversation';
import {useMessengerStore} from '@/modules/messenger/store/messengerStore';
import type {LocalConversation} from '@/modules/messenger/store/types';

function Harness({id, defer, ready}: {id: string; defer?: boolean; ready?: boolean}): null {
  useActiveConversation(id, defer ? {deferFirstUnreadClear: true, unreadClearReady: ready} : undefined);
  return null;
}

const activeId = (): string | null => useMessengerStore.getState().activeConversationId;
const unread = (id: string): number => useMessengerStore.getState().conversations[id]?.unread_count ?? 0;

function conv(id: string, unreadCount: number): LocalConversation {
  return {
    id,
    type:          'direct',
    name:          id,
    participants:  [],
    unread_count:  unreadCount,
    is_muted:      false,
    created_at:    new Date('2026-08-01T00:00:00Z').toISOString(),
    peer:          {userId: 'peer-1', deviceId: 1},
    session_state: 'established',
  } as unknown as LocalConversation;
}

let appStateHandlers: Array<(s: string) => void> = [];

beforeEach(() => {
  mockFocusState.focused = true;
  appStateHandlers = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_e: string, h: (s: string) => void) => {
    appStateHandlers.push(h);
    return {remove: jest.fn()};
  }) as unknown as typeof AppState.addEventListener);
  useMessengerStore.getState().reset();
  useMessengerStore.getState().setOwner('owner-1');
  useMessengerStore.getState().upsertConversation(conv('c1', 4));
  useMessengerStore.getState().upsertConversation(conv('c2', 7));
});

afterEach(() => {
  jest.restoreAllMocks();
});

const emitAppState = (s: string): void => { for (const h of appStateHandlers) {h(s);} };

describe('MR-11 — the id is pinned only while focused AND foreground', () => {
  it('pins on focus, and the deferred first pin leaves the unread clear to the screen', () => {
    render(<Harness id="c1" defer />);
    expect(activeId()).toBe('c1');
    // B-691/F3 — zeroing here re-renders the list behind the open slide.
    expect(unread('c1')).toBe(4);
  });

  it('without the defer opt-in the pin clears unread immediately (department chat)', () => {
    render(<Harness id="c1" />);
    expect(activeId()).toBe('c1');
    expect(unread('c1')).toBe(0);
  });

  it('LANE (a) — losing focus to a pushed screen RELEASES the thread', () => {
    const {rerender} = render(<Harness id="c1" defer />);
    expect(activeId()).toBe('c1');

    mockFocusState.focused = false; // ContactInfo / Settings / CallScreen pushed over the chat
    rerender(<Harness id="c1" defer />);

    // Still mounted underneath — and no longer silencing itself.
    expect(activeId()).toBeNull();
  });

  it('LANE (b) — pressing Home RELEASES the thread even though focus never changed', () => {
    render(<Harness id="c1" defer />);
    expect(activeId()).toBe('c1');

    emitAppState('background');

    expect(activeId()).toBeNull();
  });

  it("iOS 'inactive' does NOT release it — the user is still on the thread", () => {
    render(<Harness id="c1" defer />);
    emitAppState('inactive'); // fires for every incoming banner / control-centre swipe
    expect(activeId()).toBe('c1');
  });

  it('resuming re-pins AND clears what piled up while backgrounded', () => {
    render(<Harness id="c1" defer />);
    emitAppState('background');
    expect(activeId()).toBeNull();

    // Messages landed while the app was away — they bumped unread precisely
    // because the thread was released.
    useMessengerStore.getState().upsertConversation(conv('c1', 3));
    emitAppState('active');

    expect(activeId()).toBe('c1');
    expect(unread('c1')).toBe(0);
  });

  it('re-focusing a thread clears its unread — the defer applies to the FIRST pin only', () => {
    const {rerender} = render(<Harness id="c1" defer />);
    mockFocusState.focused = false;
    rerender(<Harness id="c1" defer />);
    useMessengerStore.getState().upsertConversation(conv('c1', 5));

    mockFocusState.focused = true; // back from contact info
    rerender(<Harness id="c1" defer />);

    expect(activeId()).toBe('c1');
    expect(unread('c1')).toBe(0);
  });

  it('Fix #31 — the release never blanks a chat that has already claimed the id', () => {
    const {unmount} = render(<Harness id="c1" defer />);
    // Rapid back-out + drill into another chat: screen B pins itself before
    // screen A's cleanup runs.
    useMessengerStore.getState().setActiveConversation('c2');

    unmount();

    expect(activeId()).toBe('c2');
  });
});

/**
 * The behavioural pins above cover the hook. This covers the thing that
 * actually regressed: two screens carrying their OWN drifted copy of the
 * pin/clear pair, only one of which had even the focus half.
 */
describe('MR-11 — both chat surfaces route through the one hook', () => {
  // These files are CRLF; a \n-anchored regex matches nothing and passes
  // vacuously. Comments are stripped so prose naming a banned call can't stand
  // in for the call — but LINE-BY-LINE, never with a `/*...*/` regex: these
  // screens contain `/*` inside string/regex literals, and the block stripper
  // swallowed from there to the next `*/`, taking real code (including the
  // call this asserts) with it. That trap has cost this repo a session before.
  const read = (f: string): string =>
    readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', f), 'utf8')
      .split(/\r?\n/)
      .filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l))
      .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n');

  it.each(['ChatScreen.tsx', 'DepartmentChatScreen.tsx'])('%s calls useActiveConversation', f => {
    expect(read(f)).toMatch(/useActiveConversation\(/);
  });

  it('neither screen writes the id itself — not a release, and not a PIN', () => {
    // Critic round 2: banning only the release left `ChatScreen` with a second
    // WRITER — its `transitionDone` effect's `setActive(conversationId)`. That
    // gate opens on a 400 ms fallback timer that survives backgrounding and
    // blur, so it could re-pin a released thread or clobber the chat the user
    // had moved to. The screen now hands the gate to the hook instead.
    expect(read('ChatScreen.tsx')).not.toMatch(/setActive(Conversation)?\(/);
    expect(read('ChatScreen.tsx')).toMatch(/unreadClearReady:\s*transitionDone/);
    expect(read('DepartmentChatScreen.tsx')).not.toMatch(/setActiveConversation\(/);
  });
});

/**
 * Critic round 2. The screen used to run the B-691/F3 deferred unread-clear
 * itself, as a second writer of the same id — and that gate opens on a 400 ms
 * FALLBACK TIMER which keeps running while the app is backgrounded and after
 * the screen has blurred. So it could re-pin a thread the hook had just
 * released, or overwrite the pin of the chat the user had already moved to.
 */
describe('MR-11 — the deferred unread clear obeys the same two facts as the pin', () => {
  it('clears unread when the gate opens while focused and foreground', () => {
    const {rerender} = render(<Harness id="c1" defer ready={false} />);
    expect(activeId()).toBe('c1');
    expect(unread('c1')).toBe(4);

    rerender(<Harness id="c1" defer ready />); // transitionDone
    expect(activeId()).toBe('c1');
    expect(unread('c1')).toBe(0);
  });

  it('a gate that opens AFTER the user pressed Home does not re-pin the thread', () => {
    const {rerender} = render(<Harness id="c1" defer ready={false} />);
    emitAppState('background');
    expect(activeId()).toBeNull();

    // The 400 ms fallback timer fires; JS is not paused by backgrounding.
    (AppState as unknown as {currentState: string}).currentState = 'background';
    rerender(<Harness id="c1" defer ready />);

    expect(activeId()).toBeNull();
  });

  it('a gate that opens AFTER blur does not clobber the chat now on screen', () => {
    const {rerender} = render(<Harness id="c1" defer ready={false} />);
    mockFocusState.focused = false;
    rerender(<Harness id="c1" defer ready={false} />);
    // The user is now reading another chat.
    useMessengerStore.getState().setActiveConversation('c2');

    rerender(<Harness id="c1" defer ready />);

    expect(activeId()).toBe('c2');
  });

  it('the AppState listener is REMOVED on blur — a leaked one re-pins on every resume', () => {
    const removes: jest.Mock[] = [];
    (AppState.addEventListener as jest.Mock).mockImplementation(((_e: string, h: (s: string) => void) => {
      appStateHandlers.push(h);
      const remove = jest.fn();
      removes.push(remove);
      return {remove};
    }) as unknown as typeof AppState.addEventListener);

    const {rerender} = render(<Harness id="c1" defer />);
    expect(removes).toHaveLength(1);
    expect(removes[0]).not.toHaveBeenCalled();

    mockFocusState.focused = false;
    rerender(<Harness id="c1" defer />);
    expect(removes[0]).toHaveBeenCalled();
  });
});
