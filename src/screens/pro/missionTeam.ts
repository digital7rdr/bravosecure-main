/**
 * B-681 — the Designated Team screen must also show the teams assigned on
 * SCHEDULED in-plan booking requests (founder, annotated screenshots
 * 2026-08-27: "for this scheduled dates which is now there is no designated
 * team" / "must also show in Designated Team").
 *
 * There is no per-officer assignment row for these: ops schedules a mission
 * with `assigned_team: [{role, count, label}]` where the label carries the
 * officer names as free text ("Roger, Ranger Big Man, …"). This helper turns
 * those mission rows into renderable sections; it is pure so the app-project
 * suite can pin it without mounting the screen.
 */
import type {ProPlanMission} from '@services/api';
import {formatDateRanges} from '@utils/datetime';

export interface MissionTeamRow {
  count: number;
  role: string;
  names: string[];
}

export interface MissionTeamSection {
  id: string;
  /** ISO dates, sorted ascending. */
  dates: string[];
  datesLabel: string;
  liveToday: boolean;
  rows: MissionTeamRow[];
}

/** `todayIso` = YYYY-MM-DD in UTC (the @utils/datetime UTC-everywhere rule). */
export function missionTeamSections(
  missions: ProPlanMission[],
  todayIso: string,
): MissionTeamSection[] {
  return missions
    .filter(m => m.status === 'SCHEDULED' && (m.assigned_team?.length ?? 0) > 0)
    .map(m => {
      const dates = [...m.mission_dates].sort();
      return {
        id: m.id,
        dates,
        datesLabel: formatDateRanges(dates),
        liveToday: dates.includes(todayIso),
        rows: m.assigned_team.map(t => ({
          count: t.count,
          role: t.role,
          names: (t.label ?? '').split(',').map(s => s.trim()).filter(Boolean),
        })),
      };
    })
    .sort((a, b) => (a.dates[0] ?? '').localeCompare(b.dates[0] ?? ''));
}
