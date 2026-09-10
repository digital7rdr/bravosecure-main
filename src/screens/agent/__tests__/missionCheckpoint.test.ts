/**
 * The "Client Picked Up" checkpoint (founder deck, August 2026, pages 3 and 21).
 *
 * The deck's contract, verbatim: the control requires a deliberate tap AND
 * confirmation; it is shown when the team is at or near the pickup point, with an
 * operational override; it records who/where/when; it notifies the Bravo Control
 * System and updates the client-facing status; and it switches navigation from
 * the pickup to the drop-off.
 *
 * What this pins is the part that is easy to get wrong and invisible when it is:
 *   - the tracker must not grow a SECOND copy of the FSM call (the CPO Mission tab
 *     owns the error translation, the session-loss branch and the never-optimistic
 *     re-read; a divergent copy loses all three);
 *   - the confirm branch must advance the action it is CONFIRMING — it used to
 *     hard-code 'finish' because Finish was the only confirmed action, so making
 *     Client Picked Up confirm would otherwise have completed the mission and
 *     released payment;
 *   - the pill must be anchored OFF the measured dock, never appended to it: the
 *     dock's height drives the style column, the slide handle and the WebView's
 *     FOLLOW pill, and growing it silently unmounts chrome on a short screen.
 *
 * Source scans: this screen cannot be imported by the node projects (WebView +
 * Mapbox). Comments are stripped and the file is CRLF-normalised — both are
 * CLAUDE.md scan traps.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(rel: string[]): string {
  const src = readFileSync(join(process.cwd(), ...rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) {inBlock = false;}
      continue;
    }
    if (t.startsWith('/*') || t.startsWith('{/*')) {
      if (!t.includes('*/')) {inBlock = true;}
      continue;
    }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const TRACKER = code(['src', 'screens', 'agent', 'AgentLiveTrackerScreen.tsx']);
const CPO = code(['src', 'screens', 'cpo', 'AssignedMissionDetailScreen.tsx']);
const ACTION = code(['src', 'screens', 'cpo', 'missionAction.ts']);
const HOOK = code(['src', 'screens', 'cpo', 'useMissionAdvance.ts']);

describe('exactly ONE caller of the mission FSM endpoints', () => {
  it('the transition lives in the shared hook', () => {
    expect(HOOK).toContain('agentApi.missionPickup');
    expect(HOOK).toContain('agentApi.missionGoLive');
    expect(HOOK).toContain('agentApi.missionComplete');
  });

  it('neither screen calls the endpoints directly', () => {
    for (const [name, src] of [['tracker', TRACKER], ['cpo', CPO]] as const) {
      expect(`${name}:${/agentApi\.missionGoLive/.test(src)}`).toBe(`${name}:false`);
      expect(`${name}:${/agentApi\.missionPickup/.test(src)}`).toBe(`${name}:false`);
      expect(`${name}:${/agentApi\.missionComplete/.test(src)}`).toBe(`${name}:false`);
    }
  });

  it('both screens drive the same selector and the same hook', () => {
    for (const src of [TRACKER, CPO]) {
      expect(src).toContain('missionActionView(');
      expect(src).toContain('useMissionAdvance(');
      expect(src).toContain('missionActionConfirm(');
    }
  });
});

describe('the confirm advances the action being confirmed', () => {
  it('no screen hard-codes the advanced action inside the confirm branch', () => {
    // The original bug shape: Alert -> onPress -> runAction('finish').
    for (const src of [TRACKER, CPO]) {
      expect(src).not.toMatch(/runAction\('finish'\)/);
      expect(src).not.toMatch(/runAction\('go-live'\)/);
    }
  });

  it('Client Picked Up demands a confirmation, and names what is being attested', () => {
    expect(ACTION).toMatch(/case 'go-live': return \{action, label: 'Client Picked Up', confirm: true\}/);
    expect(ACTION).toContain('Confirm the client is in the vehicle');
  });
});

describe('the checkpoint is offered near the pickup, with an override', () => {
  it('uses a client-side radius that never becomes a server gate', () => {
    expect(TRACKER).toMatch(/const PICKUP_RADIUS_M = \d+;/);
    expect(TRACKER).toContain('distToPickupM > PICKUP_RADIUS_M');
  });

  it('an out-of-radius tap is still possible but must state the distance', () => {
    expect(TRACKER).toContain('from the pickup point.');
    expect(TRACKER).toContain('formatDistance(distToPickupM as number)');
    // Demoted, not hidden — hiding it strands a driver with a bad pickup pin.
    expect(TRACKER).toContain('farFromPickup && s.checkpointFar');
  });

  // B-644 — the founder saw ARRIVED AT PICKUP 12 km out and could not tell it was
  // gated. The old far state only swapped one solid fill for a slightly darker
  // solid fill, which on a dark map still reads as the live primary action; the
  // distance existed ONLY inside the post-tap confirm. The range must be legible
  // BEFORE the tap.
  it('shows the range ON the button, so the gate is visible before tapping', () => {
    expect(TRACKER).toContain('s.checkpointRangePill');
    expect(TRACKER).toMatch(/farFromPickup && distToPickupM !== null && \(/);
    expect(TRACKER).toMatch(/checkpointRangeTxt[^]*?formatDistance\(distToPickupM\)/);
    // A distinct icon too — the check glyph is what made it read as "do it now".
    expect(TRACKER).toMatch(/farFromPickup \? 'map-marker-distance' : checkpointIcon\(av\.action\)/);
    // The a11y label must carry it as well, not just the pixels.
    expect(TRACKER).toContain('Not there yet');
  });

  it('the far state is OUTLINED, not another solid primary fill', () => {
    const far = TRACKER.slice(TRACKER.indexOf('checkpointFar: {'));
    const block = far.slice(0, far.indexOf('},') + 2);
    expect(block).toMatch(/backgroundColor: 'rgba\(/);   // translucent, not a solid hex
    expect(block).toMatch(/shadowOpacity: 0/);           // no primary lift
    expect(block).not.toMatch(/backgroundColor: '#[0-9A-Fa-f]{6}'/);
  });
});

describe('everyone assigned sees the same stage', () => {
  it('the lead flag rides on the poll that already runs', () => {
    expect(TRACKER).toContain('setIsLead(data.crew_role?.is_lead === true)');
  });

  it('a non-lead sees the same next step, read-only rather than a dead button', () => {
    // The server enforces lead_only; a tappable control would just 400.
    expect(TRACKER).toContain('const leadNext = missionActionView(missionStatus, true)');
    expect(TRACKER).toContain('LEAD CONFIRMS');
    expect(TRACKER).toMatch(/av\.action === 'none' && !isLead && leadNext\.action !== 'none'/);
  });
});

describe('the pill cannot break the measured-dock contract', () => {
  it('is anchored OFF the dock, not appended to it', () => {
    // Appending would grow dockHeight, which drives the style column, the slide
    // handle and the WebView FOLLOW pill.
    expect(TRACKER).toMatch(/s\.checkpoint,\s*\n\s*\{bottom: \(dockHeight \|\| 0\) \+ 12\}/);
  });

  it('insets on the right so it clears the FOLLOW pill and the slide handle', () => {
    const block = TRACKER.slice(TRACKER.indexOf('  checkpoint: {'));
    expect(block.slice(0, 400)).toMatch(/right: 96/);
  });

  it('hides while the composer is focused, like every other map overlay', () => {
    expect(TRACKER).toMatch(/\{!focused && av\.action !== 'none' &&/);
  });
});

describe('confirming immediately re-reads truth so navigation flips legs', () => {
  it('the hook reloads after the call rather than moving state optimistically', () => {
    expect(HOOK).toMatch(/await call\(missionId, fix\);\s*\n\s*await reload\(\);/);
  });

  it('the tracker passes its own poll as the reload', () => {
    // Without this the driver keeps being routed to the pickup they are standing
    // at until the next 4 s poll lands.
    expect(TRACKER).toContain('useMissionAdvance(missionId, refresh)');
  });
});
