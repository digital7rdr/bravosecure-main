/**
 * Channels vs2 item 4 — "my shifts" and "my reports" stay CROSS-ORG, labelled.
 *
 * Founder decision 2026-08-12: scoping these four self-read screens is the tidy
 * answer and was rejected, because the workspace context is not persisted — it
 * is gone after every restart, every notification tap, and everywhere in the
 * officer shell. A list scoped against a context that is usually absent becomes
 * "some of my shifts", and a missing attendance record is worse than a
 * confusing extra row. So the data stays and each row names its owner.
 *
 * These pin the two halves that are easy to get wrong: WHEN a label appears
 * (only for someone who actually has more than one organisation) and the
 * clock-out line (always, because it is a state change).
 */
// The module exports a hook alongside the pure helpers, so importing it pulls
// in the auth store and its native dependencies. Mocked so these stay unit
// tests of the two decisions, not an integration test of the store.
jest.mock('@store/authStore', () => ({useAuthStore: jest.fn()}));

import {orgLabelFor, endShiftLabel} from '../crossOrgLabel';

describe('orgLabelFor — the label only earns its place when it disambiguates', () => {
  it('names the organisation for a multi-org person', () => {
    expect(orgLabelFor({org_name: 'Meridian Protective'}, true)).toBe('Meridian Protective');
  });

  it('shows NOTHING for the single-org majority', () => {
    // One employer, one company: repeating its name on every row of a list read
    // daily is pure noise, and noise has a real cost.
    expect(orgLabelFor({org_name: 'Meridian Protective'}, false)).toBeNull();
  });

  it('returns null, not an empty string, when the server sent no name', () => {
    // An older server omits org_name entirely. Null so the caller renders
    // nothing at all rather than an empty chip with padding around it.
    expect(orgLabelFor({org_name: null}, true)).toBeNull();
    expect(orgLabelFor({}, true)).toBeNull();
    expect(orgLabelFor(undefined, true)).toBeNull();
    expect(orgLabelFor({org_name: '   '}, true)).toBeNull();
  });
});

describe('endShiftLabel — the clock-out always says what it will end', () => {
  it('names the organisation and the site', () => {
    /**
     * The one case in this decision with a functional consequence. The
     * open-session uniqueness rule is per PERSON, not per organisation, so from
     * inside Acme this button can legitimately close a Meridian shift. That is
     * correct — one body, one shift — but nothing on screen said which.
     */
    expect(endShiftLabel({org_name: 'Meridian Protective', site_label: 'Gate B'}))
      .toBe('End shift — Meridian Protective · Gate B');
  });

  it('degrades cleanly when only one of the two is known', () => {
    expect(endShiftLabel({org_name: 'Meridian Protective', site_label: null}))
      .toBe('End shift — Meridian Protective');
    expect(endShiftLabel({site_label: 'Gate B'})).toBe('End shift — Gate B');
  });

  it('never renders a dangling separator when nothing is known', () => {
    // A legacy clock-in has no assigned shift at all, so this must still be a
    // usable button rather than "End shift — ".
    expect(endShiftLabel(null)).toBe('End shift');
    expect(endShiftLabel(undefined)).toBe('End shift');
    expect(endShiftLabel({org_name: '  ', site_label: ''})).toBe('End shift');
  });

  it('is NOT gated on multi-org — a single-org person still gets the name', () => {
    /**
     * Deliberate asymmetry with the list labels: naming a state change is worth
     * a string even for someone with one employer; repeating their company on
     * fifty list rows is not.
     *
     * Asserted on BEHAVIOUR. The first version checked `endShiftLabel.length`,
     * which is vacuous — JS omits defaulted parameters from `Function.length`,
     * so `endShiftLabel(shift, show = true)` — the most likely way someone
     * would gate it — still reports 1 and the test passes.
     */
    expect(endShiftLabel({org_name: 'Meridian'})).toBe('End shift — Meridian');
  });

  it('truncates rather than overflowing the fixed-height button', () => {
    // The button is a 56dp row; both halves are free text with no length limit
    // in the schema. Clipping here keeps every caller safe.
    const long = endShiftLabel({
      org_name: 'Meridian Protective Services International',
      site_label: 'North Gate Vehicle Screening Point',
    });
    expect(long.startsWith('End shift — ')).toBe(true);
    expect(long.length).toBeLessThanOrEqual('End shift — '.length + 28);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('useShowOrgLabels — who counts as multi-org', () => {
  /**
   * The hook is a one-line selector over the auth store, and that selector is
   * the whole decision: get it wrong and either everyone sees redundant labels
   * or the consultant sees none. Captured and called directly rather than
   * rendered, so this stays a unit test.
   */

  const {useAuthStore} = require('@store/authStore') as {useAuthStore: jest.Mock};

  const {useShowOrgLabels} = require('../crossOrgLabel') as {useShowOrgLabels: () => boolean};

  // Named useDecide so the rules-of-hooks lint accepts the call inside it.
  // It is not a component; it captures the selector and runs it directly.
  const useDecide = (user: unknown): boolean => {
    let selector: ((s: unknown) => boolean) | null = null;
    useAuthStore.mockImplementation((sel: (s: unknown) => boolean) => { selector = sel; return false; });
    useShowOrgLabels();
    expect(selector).not.toBeNull();
    return selector!({user});
  };

  it('is false for one workspace and nothing else', () => {
    expect(useDecide({workspaces: [{org_id: 'acme'}]})).toBe(false);
  });

  it('is false for an agency officer with no workspace', () => {
    expect(useDecide({org: {id: 'meridian'}, workspaces: []})).toBe(false);
  });

  it('is TRUE for the consultant — an agency plus a workspace', () => {
    /**
     * THE persona this whole decision exists for. `workspaces` never contains
     * the agency (an agency roster is not an enterable workspace tile), so
     * counting only that array would have read "one organisation" for the one
     * person whose list is actually mixed — the labels would be absent for
     * exactly the user who needs them.
     */
    expect(useDecide({org: {id: 'meridian'}, workspaces: [{org_id: 'acme'}]})).toBe(true);
  });

  it('is TRUE for a manager of an AGENCY plus a workspace', () => {
    /**
     * `workspaces` INNER JOINs `org_workspaces`, so an agency membership is
     * structurally absent from it — correct for the hub, where an agency roster
     * is not an enterable tile, and wrong for counting. `managed_org` is the
     * fact that exists for exactly this, and omitting it made a manager of two
     * agencies read as ONE organisation.
     */
    expect(useDecide({managed_org: {id: 'meridian'}, workspaces: [{org_id: 'acme'}]})).toBe(true);
  });

  it('is TRUE for a company agent who joined another workspace', () => {
    /**
     * The B-417 persona. An agency's own account IS its org — its user id is
     * the org id — so nothing in `org` or `workspaces` names it once the
     * discriminator has resolved to the joined workspace instead. Inferring
     * that identity from a proxy rather than reading `owns_agency` is the
     * mistake B-417 shipped; dropping the flag repeats it.
     */
    expect(useDecide({
      id: 'agency-1', owns_agency: true, workspaces: [{org_id: 'acme'}],
    })).toBe(true);
  });

  it('does not count an agency that is ALSO the primary org twice', () => {
    expect(useDecide({id: 'agency-1', owns_agency: true, org: {id: 'agency-1'}})).toBe(false);
  });

  it('is TRUE for two workspaces', () => {
    expect(useDecide({workspaces: [{org_id: 'acme'}, {org_id: 'borealis'}]})).toBe(true);
  });

  it('does not double-count one org that appears in both places', () => {
    // A workspace owner's primary org IS their workspace, so the same id
    // arrives twice — that is one organisation, not two.
    expect(useDecide({org: {id: 'acme'}, workspaces: [{org_id: 'acme'}]})).toBe(false);
  });

  it('is false for a user with nothing, and for no user at all', () => {
    expect(useDecide({})).toBe(false);
    expect(useDecide(null)).toBe(false);
  });
});

describe('every cross-org list actually adopted the helper', () => {
  /**
   * "One helper, not five inline checks" is only true if all five USE it, and
   * nothing made that so — two lists shipped unlabelled, one of them thirty
   * lines above an edit in the same file. That is the repo's duplicate-copy
   * class arriving by omission rather than by copy-paste, and per the standing
   * rule the guard has to be a source scan: a unit test cannot see copy N+1.
   *
   * Derived from the CALLERS of the two cross-org endpoints, not from a
   * hand-listed set — a new screen that reads `myShifts` is caught the day it
   * is written.
   */

  const {readFileSync} = require('fs') as typeof import('fs');

  const {execSync} = require('child_process') as typeof import('child_process');

  const files = execSync('git ls-files "src/screens/**/*.tsx"', {encoding: 'utf8'})
    .split(/\r?\n/).filter(Boolean);

  it('every screen rendering myShifts or incidents.mine rows labels them', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const code = readFileSync(f, 'utf8').split(/\r?\n/).filter(l => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      }).join('\n');

      // Reads a cross-org list...
      const readsList = /attendanceApi\.myShifts\(|incidentApi\.mine\(/.test(code);
      if (!readsList) {continue;}
      // ...and renders per-row JSX from it (a screen that only counts rows, or
      // derives a single status, is not a list and is out of scope).
      const rendersRows = /\bshifts\b[\s\S]{0,40}?\.map\(|\brows\b[\s\S]{0,40}?\.map\(|\bdata\b[\s\S]{0,40}?\.map\(/.test(code);
      if (!rendersRows) {continue;}

      if (!/orgLabelFor\(/.test(code)) {offenders.push(f);}
    }
    expect(offenders).toEqual([]);
  });

  /**
   * ⚠️ WHAT THIS SCAN DOES NOT CATCH, stated so nobody trusts it further than
   * it goes: it proves each qualifying screen REFERENCES `orgLabelFor`, not
   * that the reference is live. Wrapping the call in `{false ? … : null}`
   * leaves the token present and the scan green — the "a token exists somewhere
   * in the file" weakness this repo has been bitten by before.
   *
   * It is still the right gate for the failure that actually happened — two
   * screens that never adopted the helper at all — and deliberately disabling a
   * call is a different, louder kind of change. The label LOGIC is covered by
   * the unit tests above; only its wiring rests on this.
   */

  it('...and the scan is not vacuous — it finds the screens it is meant to check', () => {
    // If the detector ever stops matching, the assertion above passes over an
    // empty set and guards nothing. Pin that it sees a real population.
    const seen = files.filter(f => /attendanceApi\.myShifts\(|incidentApi\.mine\(/
      .test(readFileSync(f, 'utf8')));
    expect(seen.length).toBeGreaterThanOrEqual(4);
  });
});
