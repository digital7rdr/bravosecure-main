/**
 * D3 (critic finding) — B-324's re-route was silently dead for channels.
 *
 * The msg-wake tap handler navigates TWICE: immediately to the best-known
 * target, then again if the server pull disagrees. The second navigate is
 * guarded by "is the user still where we put them?", so a user who has since
 * walked away is not yanked out of the screen they chose.
 *
 * That guard asked `current.name === 'Chat'`. F4 then let the IMMEDIATE navigate
 * land on `DepartmentChat` / `DepartmentChannels` — and the guard was never
 * taught. For a channel it could only ever answer "no", so the pull's correction
 * was dropped and the user was left on the WRONG conversation, with the tap
 * looking like it had worked.
 *
 * ONE BEHAVIOUR, TWO COPIES: the destination and the test for having arrived
 * there were written out twice, and only one was updated. The fix derives both
 * from `threadRouteName`, so they cannot disagree again — and THAT is what this
 * pins, rather than the specific literals, because pinning the literals is how
 * the next reader "fixes" it by adding a third branch.
 *
 * WHY A SOURCE SCAN. Reaching the guard behaviourally needs the pull to return a
 * DIFFERENT conversation than the banner's, on top of the full notifee + store +
 * AsyncStorage harness. The rule here is that two decision sites agree, which is
 * a structural property; `deptChannelNotifTap.test.ts` covers the routing
 * behaviour itself.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Comments here DESCRIBE the banned shape at length — a naive scan matches the
 * prose instead of the code, which is this repo's most common false pass. Strip
 * block and line comments first. The file is CRLF, so split on /\r?\n/: a
 * `\n`-anchored regex would match nothing and pass VACUOUSLY.
 */
function code(...rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
}

const FCM = code('src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts');

/** The `stillOnTapTarget` decision site, not the whole file. */
function guardSite(): string {
  const i = FCM.indexOf('const stillOnTapTarget');
  expect(i).toBeGreaterThan(-1);
  return FCM.slice(i, FCM.indexOf(';', FCM.indexOf('MessengerHome', i)) + 1);
}

describe('the B-324 re-route guard agrees with where the tap actually went', () => {
  it('derives the expected route instead of hard-coding Chat', () => {
    const site = guardSite();
    expect(site).toMatch(/current\.name === immediateRoute/);
    // THE REGRESSION. A literal 'Chat' here is the bug returning: it is true
    // only for ordinary threads, so every channel re-route is dropped.
    expect(site).not.toMatch(/current\.name === 'Chat'/);
  });

  it('the expected route comes from the SAME function that chose it', () => {
    expect(FCM).toMatch(/const immediateRoute = threadRouteName\(dept\)/);
    // …and the navigate switches on it too, so there is one source and not two
    // agreeing-by-coincidence copies.
    expect(FCM).toMatch(/const route = threadRouteName\(dept\)/);
    expect(FCM).toMatch(/if \(route === 'DepartmentChat'\)/);
    expect(FCM).toMatch(/if \(route === 'DepartmentChannels'\)/);
  });

  it('reads the conversation id under the key DepartmentChat actually uses', () => {
    // DepartmentChat carries it as `groupConversationId`; Chat as
    // `conversationId`. Reading only the latter fails the guard on channels even
    // once the route name matches — the same bug one layer down.
    expect(FCM).toMatch(
      /currentParams\.groupConversationId \?\? currentParams\.conversationId/,
    );
    expect(FCM).toMatch(/groupConversationId\?: string/);
  });

  it('does not compare an id for the directory, which carries none', () => {
    expect(guardSite()).toMatch(/immediateRoute === 'DepartmentChannels' \|\|/);
  });

  it('threadRouteName covers all three destinations', () => {
    const i = FCM.indexOf('function threadRouteName');
    expect(i).toBeGreaterThan(-1);
    const fn = FCM.slice(i, FCM.indexOf('\n}', i));
    expect(fn).toMatch(/dept\?\.channelId.*return 'DepartmentChat'/s);
    expect(fn).toMatch(/if \(dept\).*return 'DepartmentChannels'/s);
    expect(fn).toMatch(/return 'Chat'/);
  });
});
