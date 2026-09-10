/**
 * NAV-04/05/15/18/19/22 (2026-08-26 back-navigation & rapid-use audit) —
 * messenger-side pins. These screens mount RN trees the node project cannot
 * import, so the pins are comment-stripped source scans (house rules: files
 * are CRLF — normalize first; strip comments so prose can never satisfy or
 * defeat an assertion; anchor at the decision site).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const read = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const HOME  = 'src/screens/messenger/MessengerHomeScreen.tsx';
const FILES = 'src/screens/messenger/FilesScreen.tsx';
const GROUPS = 'src/screens/messenger/GroupsScreen.tsx';
const CHAT  = 'src/screens/messenger/ChatScreen.tsx';
const DEPT  = 'src/screens/messenger/DepartmentChatScreen.tsx';

/**
 * NAV-04/NAV-05 — every BackHandler registration in a screen that stays
 * mounted under pushed routes must be FOCUS-scoped. RN dispatches
 * hardwareBackPress LIFO, none of the pushed screens registers a handler, so
 * a mount-scoped (useEffect) handler here SWALLOWS the first back press on
 * every screen above it — the client's "back button does nothing" verbatim.
 *
 * The scan: for each `BackHandler.addEventListener` site, the nearest
 * preceding hook opener must be `useFocusEffect`, never `useEffect`.
 */
function assertBackHandlersFocusScoped(file: string) {
  const src = strip(read(file));
  const sites: number[] = [];
  let at = src.indexOf('BackHandler.addEventListener');
  while (at !== -1) {
    sites.push(at);
    at = src.indexOf('BackHandler.addEventListener', at + 1);
  }
  expect(sites.length).toBeGreaterThan(0); // control: the handlers exist
  for (const site of sites) {
    const before = src.slice(0, site);
    const lastFocus = before.lastIndexOf('useFocusEffect(');
    const lastPlain = before.lastIndexOf('useEffect(');
    expect(lastFocus).toBeGreaterThan(-1);
    // `useFocusEffect(` contains no `useEffect(` substring, so the two
    // indexes are independent; the focus opener must be the nearer one.
    expect(lastFocus).toBeGreaterThan(lastPlain);
  }
}

describe('NAV-04/05 — mounted-under list screens register hardware back FOCUS-scoped', () => {
  it('MessengerHomeScreen (both handlers: chat-select exit + tab reset)', () => {
    assertBackHandlersFocusScoped(HOME);
  });
  it('FilesScreen (selection-mode exit)', () => {
    assertBackHandlersFocusScoped(FILES);
  });
});

describe('NAV-18/19 — the dept-channel focus refetch keeps the Set identity when unchanged', () => {
  // An unconditional setDeptGroupIds(new Set(...)) hands React a fresh
  // identity on EVERY focus, invalidating the list-order memo and forcing a
  // full re-sort + FlatList re-render while the pop animation runs.
  it('MessengerHomeScreen guards the write with sameIdSet', () => {
    const src = strip(read(HOME));
    const at = src.indexOf('setDeptGroupIds(');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 260)).toMatch(/sameIdSet\(prev, next\)/);
  });
  it('GroupsScreen guards the write with sameIdSet', () => {
    const src = strip(read(GROUPS));
    const at = src.indexOf('setDeptGroupIds(');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 260)).toMatch(/sameIdSet\(prev, nextSet\)/);
  });
});

describe('NAV-15 — reactions carry an in-flight ref (one crypto seal per deliberate tap)', () => {
  // setActionMsg(null) closes the sheet but is React state — stale for the
  // whole mash burst. The ref is the synchronous truth.
  it.each([CHAT, DEPT])('%s', file => {
    const src = strip(read(file));
    const at = src.indexOf('const reactToMessage');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at - 400, at + 700);
    expect(body).toMatch(/reactionInFlightRef/);
    expect(body).toMatch(/if \(reactionInFlightRef\.current\) \{return;\}/);
  });
});

describe('NAV-22 — the unmount draft flush is deferred off the back-pop commit', () => {
  it('ChatScreen defers the O(conversations+groups) persist by one macrotask', () => {
    const src = strip(read(CHAT));
    // Anchor at the unmount-cleanup site: the flush must sit inside a
    // setTimeout, not run synchronously in the cleanup.
    const at = src.indexOf('const tail = textRef.current;');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toMatch(
      /setTimeout\(\(\) => persistDraftRef\.current\?\.\(tail\), 0\)/,
    );
  });
});
