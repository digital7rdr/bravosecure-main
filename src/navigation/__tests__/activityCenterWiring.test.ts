/**
 * N-18/GAP-3 (NOTIFICATION_INDUSTRY_AUDIT_2026-07-27) — the notification
 * centre is REACHABLE.
 *
 * The 2026-07-09 audit's N-18 finding ("purpose-built notification center is
 * dead code: ActivityBell unmounted, no route") outlived every intervening
 * fix: the store, the server inbox (GET /me/notifications), the watermark
 * sync (activitySync.ts, started from MainNavigator) and the wake writers
 * all shipped — and the screen stayed unroutable, the bell unmounted. A
 * feature that is 95% built and 0% reachable counts as 0%.
 *
 * Pinned here:
 *  1. ActivityCenter is a registered route in BOTH role shells (Booking =
 *     client, Agent = CPO/manager);
 *  2. the bell is mounted in both home headers and navigates to it;
 *  3. the server-side half has a MIGRATION for public.notifications — the
 *     NotificationsService writes fire-and-forget by contract, so a missing
 *     table fails silently forever (which is exactly what was happening).
 *
 * Source scans (screens/navigators mount RN views). Files are CRLF; nothing
 * here is `\n`-anchored (a `\n` anchor matches nothing and passes VACUOUSLY).
 */
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

function code(...rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

describe('N-18/GAP-3 — the notification centre is reachable', () => {
  it.each([
    ['BookingNavigator.tsx'],
    ['AgentNavigator.tsx'],
  ])('%s registers the ActivityCenter route', file => {
    const s = code('src', 'navigation', file);
    expect(s).toMatch(/name="ActivityCenter"/);
    expect(s).toMatch(/component=\{ActivityCenterScreen\}/);
  });

  it.each([
    ['src/screens/booking/BookingHomeScreen.tsx'],
    ['src/screens/agent/AgentDashboardScreen.tsx'],
  ])('%s mounts the bell and navigates to the centre', rel => {
    const s = code(...rel.split('/'));
    // NAV-10 (2026-08-26) — the bell press routes through navigateOnce now.
    expect(s).toMatch(/<ActivityBell onPress=\{\(\) => navigateOnce\(navigation, 'ActivityCenter'\)\}/);
  });

  it('the durable-inbox table has a migration', () => {
    const dir = join(process.cwd(), 'supabase', 'migrations');
    const hit = readdirSync(dir).filter(f => {
      if (!f.endsWith('.sql')) {return false;}
      return readFileSync(join(dir, f), 'utf8').includes('CREATE TABLE IF NOT EXISTS public.notifications');
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    // And it must not be an RLS-off table (the webapp audit's P1 class).
    const sql = readFileSync(join(dir, hit[0]), 'utf8');
    expect(sql).toMatch(/ALTER TABLE public\.notifications ENABLE ROW LEVEL SECURITY/);
  });

  /**
   * Client review vs2 item 16 — the DURABLE lane must deep-link too.
   *
   * The transient Redis blob lives ~5 minutes; every delivery outside that
   * window (killed app, Doze, reinstall, dead token, Redis down) reaches the
   * user only as a bell row. `incident_id` was added to
   * `public.notifications` for exactly that, and the chain server→client is
   * four hops long: any one of them dropping the field turns the column into
   * "silence in a new place", which is what the plan warned against. Pin all
   * four, because no single test covers the seam.
   */
  describe('item 16 — the incident id survives the whole durable chain', () => {
    it('the migration adds the column', () => {
      const dir = join(process.cwd(), 'supabase', 'migrations');
      const hit = readdirSync(dir).filter(f =>
        f.endsWith('.sql') &&
        /ALTER TABLE public\.notifications[\s\S]*ADD COLUMN IF NOT EXISTS incident_id/.test(
          readFileSync(join(dir, f), 'utf8')));
      expect(hit.length).toBeGreaterThanOrEqual(1);
    });

    it('the server writes it, selects it, and MAPS it onto the response', () => {
      const svc = code('apps', 'auth-service', 'src', 'notifications', 'notifications.service.ts');
      expect(svc).toMatch(/INSERT INTO public\.notifications[\s\S]{0,200}incident_id/);
      expect(svc).toMatch(/SELECT[\s\S]{0,120}incident_id/);
      // The mapper is the hop that silently dropped it first.
      const ctl = code('apps', 'auth-service', 'src', 'notifications', 'notifications.controller.ts');
      expect(ctl).toMatch(/incidentId:\s*r\.incident_id/);
    });

    it('the client DTO carries it and the store row keeps it', () => {
      const sync = code('src', 'store', 'activitySync.ts');
      expect(sync).toMatch(/incidentId\?: string/);
      expect(sync).toMatch(/incidentId: n\.incidentId/);
      expect(code('src', 'store', 'activityStore.ts')).toMatch(/incidentId\?: string/);
    });

    it('the bell row TAPS through to an incident screen, per shell', () => {
      const screen = code('src', 'screens', 'activity', 'ActivityCenterScreen.tsx');
      // Must resolve per shell — a bare navigate to a Departmental-only route
      // is the B-258 dead tap this whole module exists to prevent.
      expect(screen).toMatch(/eventClass === 'incident'/);
      expect(screen).toMatch(/navigateToMessengerScreen\(/);
      // A manager with no id lands on the QUEUE, never on a member's own list.
      expect(screen).toMatch(/'IncidentDetail'\s*:\s*'IncidentQueue'/);
    });
  });

  /**
   * Channels vs2 edge A1/A2 — the org id survives the SAME chain, and every
   * door scopes BEFORE it routes.
   *
   * Item 16 gave the incident tap an id to open. Item 4 then made "which
   * organisation" a real question, and nothing on a tap answered it: a manager
   * of two orgs read the record with the OTHER org stamped on the request
   * (`X-Org-Context` is sticky, and session-only so null at boot), the server's
   * `WHERE id = $1 AND org_user_id = $2` matched nothing, and the screen
   * swallowed the miss into an empty state.
   *
   * The ORDERING is the whole fix — a context adopted after the navigate is a
   * context the target screen's fetch has already raced past — so it is pinned
   * per door, not just "the symbol appears in the file".
   */
  describe('edge A1/A2 — the org id survives the chain, and every door scopes first', () => {
    /** A lane of source between two code anchors, comments already stripped. */
    function lane(src: string, from: string, to: string): string {
      const i = src.indexOf(from);
      expect(i).toBeGreaterThan(-1);
      const j = src.indexOf(to, i);
      expect(j).toBeGreaterThan(i);
      return src.slice(i, j);
    }

    it('the migration adds the column', () => {
      const dir = join(process.cwd(), 'supabase', 'migrations');
      const hit = readdirSync(dir).filter(f =>
        f.endsWith('.sql') &&
        /ALTER TABLE public\.notifications[\s\S]*ADD COLUMN IF NOT EXISTS org_user_id/.test(
          readFileSync(join(dir, f), 'utf8')));
      expect(hit.length).toBeGreaterThanOrEqual(1);
    });

    it('the PRODUCERS put the org on the blob (incident + both admin-side enterprise fan-outs)', () => {
      expect(code('apps', 'auth-service', 'src', 'incident', 'incident.service.ts'))
        .toMatch(/incidentSubmitted\([\s\S]{0,400}orgId:\s*orgUserId/);
      const join_ = code('apps', 'auth-service', 'src', 'department', 'enterprise-join.service.ts');
      expect(join_).toMatch(/enterpriseJoinRequested\(uid,\s*orgUserId\)/);
      expect(join_).toMatch(/enterpriseInviteAccepted\(a,\s*inv\.org_user_id\)/);
    });

    it('the ONE record() caller outside the push bridge threads the org too', () => {
      // `enterprise.day_status` writes its inbox row directly, so the
      // bridge-side threading does not reach it. Left null, its bell row taps
      // into `openAttendance` under the sticky context — and for a recipient
      // who is also a manager that is AdminAttendance reading another org's
      // roster. The client door for this row already exists.
      const att = code('apps', 'auth-service', 'src', 'attendance', 'attendance.service.ts');
      expect(att).toMatch(/kind: 'enterprise\.day_status',\s*orgUserId/);
      // And no OTHER record() call site has been added without one.
      const callers = att.match(/notifications\.record\(/g) ?? [];
      expect(callers).toHaveLength(1);
    });

    it('enterprise banners collapse WITHIN an org, never across two', () => {
      // The collapse is deliberate (N requests → one banner). The id was
      // org-agnostic, so once the payload started deciding which org the tap
      // opens, org B's wake replaced org A's banner AND its data: a two-org
      // admin could only ever reach whichever org fired last.
      const swn = code('src', 'modules', 'messenger', 'push', 'serverWakeNotifications.ts');
      expect(swn).toMatch(/kind\.startsWith\('enterprise\.'\)[\s\S]{0,160}\$\{kind\}:\$\{data\.orgId\}/);
    });

    it('the APPLICANT-side kinds deliberately carry no org (they are cross-org self-reads)', () => {
      // Narrowing ApprovalStatus / MyIncidents to one org would HIDE the other
      // org's invites and reports — the opposite of the bug being fixed. This
      // asserts the shipped decision, so re-adding it has to be deliberate.
      const bridge = code('apps', 'auth-service', 'src', 'ops', 'booking-push-bridge.service.ts');
      // Anchored on the METHOD'S closing brace (column-2 `}`), not on the first
      // `}` after the name — that one lands inside `...(incidentId ? {incidentId}`
      // and stopped the scan mid-body, so an `orgId` spread on the next line
      // would have escaped a test that claims to pin the decision.
      expect(lane(bridge, 'async enterpriseJoinDecided', '\n  }')).not.toMatch(/orgId/);
      expect(lane(bridge, 'async incidentStatusChanged', '\n  }')).not.toMatch(/orgId/);
      // …and the anchor really does reach the end of the body.
      expect(lane(bridge, 'async incidentStatusChanged', '\n  }')).toMatch(/kind: 'incident-status'/);
    });

    it('the server threads blob → durable row → response', () => {
      const bridge = code('apps', 'auth-service', 'src', 'ops', 'booking-push-bridge.service.ts');
      expect(bridge).toMatch(/orgUserId:\s*typeof details\.orgId === 'string'/);
      const svc = code('apps', 'auth-service', 'src', 'notifications', 'notifications.service.ts');
      expect(svc).toMatch(/INSERT INTO public\.notifications[\s\S]{0,220}org_user_id/);
      expect(svc).toMatch(/SELECT[\s\S]{0,160}org_user_id/);
      expect(code('apps', 'auth-service', 'src', 'notifications', 'notifications.controller.ts'))
        .toMatch(/orgId:\s*r\.org_user_id/);
    });

    it('the client DTO carries it, the store row keeps it, and the WAKE-time row sets it', () => {
      const sync = code('src', 'store', 'activitySync.ts');
      expect(sync).toMatch(/orgId\?: string/);
      expect(sync).toMatch(/orgId: n\.orgId/);
      expect(code('src', 'store', 'activityStore.ts')).toMatch(/orgId\?: string/);
      // B-706 A-4 — RE-POINTED, not deleted. This used to assert that the LOCAL
      // wake-time row carried orgId/incidentId. There is no local wake-time row any
      // more: it keyed on the FCM eventId while the backfill keyed on the notifications
      // uuid, so every non-enterprise event landed in the feed TWICE and the badge read
      // 2N. The durable inbox is now the single minter, so the contract this pin defends
      // — a wake's bell row carries its routing fields — is upheld by the server lane
      // asserted above (orgId: n.orgId) plus the wake KICKING that lane.
      const swn = code('src', 'modules', 'messenger', 'push', 'serverWakeNotifications.ts');
      const rec = lane(swn, 'function recordActivityForWake', '\n}');
      expect(rec).toMatch(/scheduleActivitySync\(\)/);
      // The two keyspaces must not come back: no local append on the wake path.
      expect(rec).not.toMatch(/recordActivity\(/);
      expect(sync).toMatch(/incidentId: n\.incidentId/);
    });

    it('DOOR 1+2 (push tap) — both fcmBootstrap lanes adopt BEFORE they navigate', () => {
      const boot = code('src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts');
      for (const [name, from] of [
        ['incident',   'const rawInc = data.incidentId'],
        ['enterprise', "const target = kind === 'enterprise.join.requested'"],
      ] as const) {
        const body = lane(boot, from, 'return true;');
        const iAdopt = body.indexOf('adoptOrgContextFromWake(data.orgId)');
        const iNav   = body.indexOf('navigateToMessengerScreen(');
        expect([name, iAdopt > -1]).toEqual([name, true]);
        expect([name, iNav > -1]).toEqual([name, true]);
        expect([name, iAdopt < iNav]).toEqual([name, true]);
        // Awaited, or the navigate races the switch it was supposed to wait for.
        expect([name, /await adoptOrgContextFromWake/.test(body)]).toEqual([name, true]);
      }
    });

    it('DOOR 3 (durable bell row) — the workspace classes adopt BEFORE they route', () => {
      const screen = code('src', 'screens', 'activity', 'ActivityCenterScreen.tsx');
      const body = lane(screen, 'const onRow = useCallback', 'catch {');
      // BOTH workspace classes take the scoping arm — an incident row that
      // skipped it is the original A1 bug through the lane that carries every
      // delivery which missed the 5-minute blob.
      expect(body).toMatch(/eventClass === 'enterprise' \|\| row\.eventClass === 'incident'/);
      const iAdopt = body.indexOf('await adoptOrgContextFromWake(row.orgId)');
      const iRoute = body.indexOf('routeWorkspaceRow(row)');
      expect(iAdopt).toBeGreaterThan(-1);
      expect(iRoute).toBeGreaterThan(iAdopt);
    });

    /**
     * ⚠️ `expect(ARRAY).not.toContain(needle)` is ARRAY MEMBERSHIP, not
     * substring — it passes unless an ELEMENT equals the needle exactly. The
     * first version of this test wrapped the source in a `[label, source]`
     * tuple to get a readable failure and was therefore VACUOUS: a second
     * hand-rolled writer would have shipped green. `it.each` carries the label
     * instead, so the assertion can stay on the raw string.
     */
    it.each([
      ['src/modules/messenger/push/fcmBootstrap.ts'],
      ['src/screens/activity/ActivityCenterScreen.tsx'],
      ['src/modules/messenger/push/serverWakeNotifications.ts'],
    ])('ONE context writer — %s does not hand-roll setActiveWorkspace', rel => {
      // The repo's most-shipped bug is one behaviour with N drifted copies, and
      // a second writer here would skip the membership check that makes
      // client-side adoption safe at all.
      expect(code(...rel.split('/'))).not.toContain('setActiveWorkspace');
    });

    it('every door honours `superseded` — a stale tap must not navigate', () => {
      // The adopt awaits, so two taps inside that window interleave: chain 1
      // wakes holding chain 2's context and deep-links its own id against the
      // wrong org — the A1 empty screen, reintroduced by the fix.
      const boot = code('src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts');
      // THREE doors in fcmBootstrap now: incident, enterprise, and the dept-message
      // thread lane (vs2 edge A9), which adopts the org a channel belongs to.
      expect(boot.match(/[=]== 'superseded'/g) ?? []).toHaveLength(3);
      expect(code('src', 'screens', 'activity', 'ActivityCenterScreen.tsx'))
        .toMatch(/adoptOrgContextFromWake\(row\.orgId\) === 'superseded'\)\s*\{return;\}/);
    });

    it('the settle wait is LONGER than the held frame it waits for', () => {
      // Two constants in two files with no compile-time link. 120 > 30 is the
      // whole reason the deep link lands on the incident instead of the tab
      // root; raising the held frame without raising this silently breaks it.
      const settle = /SWITCH_SETTLE_MS = (\d+)/.exec(code('src', 'store', 'adoptOrgContext.ts'));
      const held = /setTimeout\(\(\) => setMountedOrg\(orgKey\), (\d+)\)/
        .exec(code('src', 'navigation', 'DepartmentalNavigator.tsx'));
      expect(settle).not.toBeNull();
      expect(held).not.toBeNull();
      expect(Number(settle![1])).toBeGreaterThan(Number(held![1]));
    });
  });
});
