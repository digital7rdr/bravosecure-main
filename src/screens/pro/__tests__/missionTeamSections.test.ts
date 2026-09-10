/**
 * B-681 — scheduled booking-request teams surface on the Designated Team
 * screen. The derivation is pure (screens/pro/missionTeam.ts); the wiring scan
 * below pins that ProAssignedTeamScreen actually consumes it — the founder's
 * screenshot bug was precisely "the data exists on Booking Requests but the
 * team screen never fetches it".
 */
import * as fs from 'fs';
import * as path from 'path';
import {missionTeamSections} from '../missionTeam';
import type {ProPlanMission} from '@services/api';

const mission = (over: Partial<ProPlanMission>): ProPlanMission => ({
  id: 'm1',
  application_id: 'a1',
  requested_by: 'u1',
  mission_dates: ['2026-08-22', '2026-08-23'],
  note: null,
  status: 'SCHEDULED',
  assigned_team: [{role: 'Close Protection Officer', count: 4, label: 'Roger, Ranger Big Man, Ranak Debnath, Leon Ward'}],
  ops_note: null,
  created_at: '2026-08-20T00:00:00Z',
  ...over,
});

describe('missionTeamSections (B-681)', () => {
  it('a SCHEDULED mission with a team becomes a section with parsed names', () => {
    const [sec] = missionTeamSections([mission({})], '2026-08-22');
    expect(sec).toBeDefined();
    expect(sec!.rows).toEqual([{
      count: 4,
      role: 'Close Protection Officer',
      names: ['Roger', 'Ranger Big Man', 'Ranak Debnath', 'Leon Ward'],
    }]);
    expect(sec!.liveToday).toBe(true);
    expect(sec!.datesLabel.length).toBeGreaterThan(0);
  });

  it('liveToday is false when today is outside the mission dates', () => {
    const [sec] = missionTeamSections([mission({})], '2026-09-01');
    expect(sec!.liveToday).toBe(false);
  });

  it('REQUESTED/DECLINED and team-less missions are excluded', () => {
    const out = missionTeamSections([
      mission({id: 'r', status: 'REQUESTED'}),
      mission({id: 'd', status: 'DECLINED'}),
      mission({id: 'e', assigned_team: []}),
    ], '2026-08-22');
    expect(out).toEqual([]);
  });

  it('sections sort by first mission date', () => {
    const out = missionTeamSections([
      mission({id: 'late', mission_dates: ['2026-09-10']}),
      mission({id: 'early', mission_dates: ['2026-08-21']}),
    ], '2026-08-22');
    expect(out.map(s => s.id)).toEqual(['early', 'late']);
  });

  it('a label-less role renders with no names instead of crashing', () => {
    const [sec] = missionTeamSections(
      [mission({assigned_team: [{role: 'Extra CPO', count: 1}]})], '2026-08-22');
    expect(sec!.rows[0]).toEqual({count: 1, role: 'Extra CPO', names: []});
  });
});

describe('ProAssignedTeamScreen wiring (source scan — the screen mounts RN and cannot be imported here)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../ProAssignedTeamScreen.tsx'), 'utf8');

  it('fetches missions alongside the dedicated team', () => {
    expect(src).toMatch(/secureProApi\.missions\(/);
  });

  it('renders sections from missionTeamSections', () => {
    expect(src).toMatch(/missionTeamSections\(/);
    expect(src).toMatch(/missionSections\.map\(/);
  });

  it("the CPOs empty state accounts for mission teams — 'no team' may not render while a scheduled mission has one", () => {
    expect(src).toMatch(/team\.length === 0 && missionSections\.length === 0/);
  });
});
