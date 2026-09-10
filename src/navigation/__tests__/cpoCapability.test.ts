import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * §35A §D capability lockdown — the CPO build must HIDE every client + agency power. The
 * hiding is STRUCTURAL (the forbidden screens are simply not registered in the CPO stack),
 * so a source scan of CpoNavigator is the right guard: it can't drift without this failing.
 */
const SRC = readFileSync(join(__dirname, '..', 'CpoNavigator.tsx'), 'utf8');

describe('CPO capability lockdown (§35A §D)', () => {
  it('registers EXACTLY the five guard tabs (On Duty / Mission / Comms / Dept / Me)', () => {
    const tabs = [...SRC.matchAll(/<Tab\.Screen name="(\w+)"/g)].map(m => m[1]).sort();
    expect(tabs).toEqual(['CpoComms', 'CpoDept', 'CpoDuty', 'CpoMe', 'CpoMission']);
  });

  it('does NOT register any forbidden client/agency capability screen', () => {
    const forbidden = [
      'BookingHome', 'ZoneMap', 'CreditPaywall', 'Credits', // client booking + wallet
      'OrgRoster', 'OrgMissions', 'OrgCreateCpo', 'OrgCompliance', // agency roster / board / crew
      'IncomingOffer', 'AssignCrew', 'JobPortal', // job-offer accept + assign-crew + marketplace claim
      'Earnings', // org money rollup
    ];
    for (const name of forbidden) {
      expect(SRC).not.toContain(`name="${name}"`);
    }
  });

  it('the Mission tab is the assigned-mission screen, not a multi-mission board', () => {
    expect(SRC).toContain('AssignedMissionDetailScreen');
    expect(SRC).not.toContain('OrgMissionsScreen'); // no agency multi-mission board
  });
});
