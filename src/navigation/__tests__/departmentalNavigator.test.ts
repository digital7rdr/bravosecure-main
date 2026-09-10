import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Dept Chat v2 — Step 19. The dedicated "Departmental" module must expose the
 * PDF's fixed 5-tab bottom nav, IN ORDER: Home · Channels · Attend · Incident ·
 * Vault, role-branch its Attend/Incident roots, and reuse the File-Vault MFA
 * gate rather than bypass it. A source scan of DepartmentalNavigator is the
 * structural guard (mirrors cpoCapability.test.ts) — the shell can't drift
 * without this failing.
 */
const SRC = readFileSync(join(__dirname, '..', 'DepartmentalNavigator.tsx'), 'utf8');

describe('Departmental module shell (Step 19)', () => {
  /**
   * UI corrections 2026-08-15 item 07 — the bar is now
   * Home · Channels · Vault · Messenger · News, superseding the vs1 rule
   * (Home + Messenger) and the Step-19 rule this test was written for.
   *
   * ⚠️ THE REGEX WAS THE BUG HERE, NOT JUST THE EXPECTATION. It used a LITERAL
   * SPACE after `<Tab.Screen`, so the multi-line `Messenger` declaration was
   * INVISIBLE to it — the assertion had silently been describing six of seven
   * tabs. Declaring `News` multi-line too would have kept this green while the
   * order was wrong. `\s+` (which spans newlines) is what makes the assertion
   * mean what it says.
   */
  it('registers every tab, in declaration order — which IS the bar order', () => {
    const tabs = [...SRC.matchAll(/<Tab\.Screen\s+name="(\w+)"/g)].map(m => m[1]);
    // The visible five first, in the PDF's order, then the two that stay
    // registered-but-hidden and are reached from the Home dashboard.
    expect(tabs).toEqual(['Home', 'Channels', 'Vault', 'Messenger', 'News', 'Attend', 'Incident']);
  });

  it('hides ONLY Attend and Incident from the bar', () => {
    // The five visible destinations must NOT carry the marker, and the two
    // module tabs must — asserting only one half would pass on an empty bar.
    const lineFor = (tab: string) =>
      SRC.split('\n').find(l => l.includes(`name="${tab}"`)) ?? '';
    for (const visible of ['Home', 'Channels', 'Vault', 'News']) {
      expect(`${visible}:${lineFor(visible).includes('HIDDEN_TAB')}`).toBe(`${visible}:false`);
    }
    for (const hidden of ['Attend', 'Incident']) {
      expect(`${hidden}:${lineFor(hidden).includes('HIDDEN_TAB')}`).toBe(`${hidden}:true`);
    }
  });

  it('News unmounts on blur — freezeOnBlur would NOT stop its timers', () => {
    /**
     * freezeOnBlur suspends RENDERING only; it does not unmount, so no
     * useEffect cleanup runs. IntelFeedScreen's 1s setInterval and its
     * Animated.loop both tear down on unmount only, and it deliberately keeps a
     * Leaflet WebView resident. As a native-stack screen those costs end when
     * you pop back; as a TAB they would run for the whole workspace session.
     */
    expect(SRC).toMatch(/<Tab\.Screen name="News"[\s\S]{0,80}?unmountOnBlur: true/);
    expect(SRC).not.toMatch(/name="News"[\s\S]{0,80}?freezeOnBlur/);
  });

  it('branches the ATTEND root by role (manager vs member)', () => {
    expect(SRC).toContain("isManager ? 'AdminAttendance' : 'Attendance'");
  });

  /**
   * UI corrections 2026-08-15 item 09 — the Incident role branch is GONE, and
   * that is the change, not a regression.
   *
   * "This screen is not relevant, as the very next screen allows you to log your
   * incidents." Both roles now root at the report screen; the manager's queue is
   * reached from a row on it, from the Home alert tile, and from its push deep
   * link. The old pin asserted the branch, so it is replaced rather than
   * deleted — with the two things that now matter instead.
   */
  it('roots the Incident tab at the REPORT screen for both roles', () => {
    expect(SRC).toMatch(/initialRouteName="ReportIncidentCategory"/);
    expect(SRC).not.toMatch(/initialRouteName=\{isManager \? 'IncidentQueue'/);
  });

  it('KEEPS IncidentQueue registered — it is a push + ActivityCenter target', () => {
    // Unregistering it to "remove the screen" would silently drop those wakes.
    // The PDF says removed from the active user FLOW, not deleted.
    expect(SRC).toMatch(/<IncidentStack\.Screen name="IncidentQueue"/);
  });

  it('reuses the File-Vault MFA gate in the Vault tab (no bypass)', () => {
    expect(SRC).toContain('component={VaultLockScreen}');
    expect(SRC).toContain('component={VaultScreen}');
  });
});

/**
 * Channels vs2 item 4 — the workspace surface must refuse to render for an org
 * the user no longer belongs to, and must genuinely re-root on a switch.
 *
 * A source scan, because nothing in this repo renders DepartmentalNavigator (it
 * mounts five real screens plus the vault MFA gate). Line-based and
 * comment-skipping: the prose here names the very shapes the assertions forbid,
 * and a greedy stripper has eaten real code in this repo before.
 */
describe('vs2 item 4 — org ejection and the switch remount', () => {
  const code = SRC.split(/\r?\n/).filter(l => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join('\n');

  it('renders the ejected notice INSTEAD of the tabs, not alongside them', () => {
    // A navigation-only fix was defeated by its own verb: WorkspaceHub and
    // Departmental are siblings on one stack, so `navigate` pushes when the hub
    // is not already below and one Back gesture returned the user to a live
    // surface bound to the wrong tenant. Refusing to render cannot be undone by
    // a gesture, and needs no route to exist in any of the three host shells.
    expect(code).toMatch(/if \(ejected\) \{[\s\S]{0,400}?<EjectedNotice/);
    // The early return must come BEFORE the navigator is built.
    expect(code.indexOf('<EjectedNotice')).toBeLessThan(code.indexOf('<Tab.Navigator'));
  });

  it('does NOT clear the latch in the dismiss handler', () => {
    // Clearing it there re-rendered the whole Tab.Navigator underneath in the
    // same commit, bound to `primary` — an AGENCY for the consultant — already
    // firing reads against it.
    // Slice from `onDismiss` to the end of the JSX element. `EjectedNotice` is
    // SELF-CLOSING, so the first version anchored on a closing tag that does not
    // exist: indexOf returned -1, `-1 + 1` is 0, the slice was empty, and the
    // assertion passed over nothing on both versions. Anchor on what is there.
    // Anchor on the USE SITE, not the first `onDismiss` in the file — that one
    // is the component's own parameter list, and slicing from there to the next
    // `/>` captured the <Icon /> inside the component body instead of the
    // handler. The assertion then ran over the wrong region and passed on both
    // versions.
    const start = code.indexOf('<EjectedNotice');
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf('/>', start);
    expect(end).toBeGreaterThan(start);
    expect(code.slice(start, end)).toMatch(/onDismiss/);
    expect(code.slice(start, end)).not.toMatch(/setEjected\(null\)/);
  });

  it('clears the latch on BLUR and on a valid context for another org', () => {
    expect(code).toMatch(/useIsFocused\(\)/);
    expect(code).toMatch(/!isFocused && ejected[\s\S]{0,80}?setEjected\(null\)/);
    expect(code).toMatch(/ejected\.orgId !== match\.org_id[\s\S]{0,60}?setEjected\(null\)/);
  });

  it('requires TWO consecutive absences before ejecting', () => {
    // Every membership is gated on the org owner's live Enterprise entitlement,
    // so a late renewal reads exactly like a removal — and would eject that
    // company's whole staff at once.
    expect(code).toMatch(/missRef/);
    expect(code).toMatch(/missRef\.current !== activeCtx\.org_id[\s\S]{0,120}?return;/);
  });

  it('holds a navigator-free frame on an org switch — a key alone is NOT a reset', () => {
    /**
     * B-95, measured on the product switch: React Navigation stores a nested
     * navigator's state on the parent route and a freshly-keyed replacement
     * REHYDRATES it, ignoring initialRouteName, because the route names match
     * on both sides. Without the held frame the key is decoration — an employee
     * stayed on AdminAttendance (403) and on the previous org's ChannelEditor.
     */
    expect(code).toMatch(/const \[mountedOrg, setMountedOrg\]/);
    expect(code).toMatch(/setTimeout\(\(\) => setMountedOrg\(orgKey\)/);
    expect(code).toMatch(/key=\{mountedOrg\}/);
    // …and the frame must actually be held: a guard that returns before the
    // navigator while the two disagree.
    expect(code).toMatch(/mountedOrg !== orgKey/);
  });
});
