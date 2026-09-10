/**
 * PDF item 08 — EVERY `tel:` HAND-OFF IS LOGGED, and a new one cannot skip it.
 *
 * A behavioural test can only cover the dial sites it imports; it is
 * structurally incapable of seeing site N+1. That is the whole failure mode
 * here — "Emergency Calls have not been added to Calls Log" was reported
 * because the log and the dialling were never connected, and the way it comes
 * back is somebody adding a fourth dial button.
 *
 * So this scans the source for the FORMULA: any `Linking.openURL('tel:…')` in a
 * screen must have `recordEmergencyCall` in the same file.
 *
 * ⚠️ Comments are stripped first. This repo has lost a session to a scan that
 * matched its own prose, and these files are heavily commented — including
 * comments that mention `tel:` by name.
 */
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

const SCREENS = join(process.cwd(), 'src', 'screens');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__') {continue;}
      sourceFiles(p, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * CRLF-normalised, comments stripped LINE-ANCHORED.
 *
 * Both halves matter and both have bitten this repo: a `\n`-anchored regex
 * matches nothing on a CRLF file so an absence scan passes VACUOUSLY, and the
 * conservative line-anchored block strip avoids eating real code when a `/*`
 * appears inside a string literal.
 */
function strip(path: string): string {
  const lines = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const t = line.trim();
    if (inBlock) {
      if (t.endsWith('*/')) {inBlock = false;}
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.endsWith('*/')) {inBlock = true;}
      continue;
    }
    if (t.startsWith('//') || t.startsWith('*')) {continue;}
    out.push(line);
  }
  return out.join('\n');
}

describe('PDF item 08 — every emergency dial is recorded', () => {
  it('no screen hands off to `tel:` without recording it', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(SCREENS)) {
      const src = strip(f);
      // The formula: an actual openURL of a tel: URL, in code, not prose.
      if (!/openURL\(\s*[`'"]tel:/.test(src)) {continue;}
      if (!/recordEmergencyCall\(/.test(src)) {
        offenders.push(f.replace(process.cwd(), ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the three known dial sites are all still wired', () => {
    /**
     * The POSITIVE half. Banning un-logged sites is worthless if the wiring
     * quietly disappears from the ones that exist — an absence assertion alone
     * passes just as happily against a file with no dialling at all.
     */
    const sites = [
      join(SCREENS, 'vbg', 'VBGEmergencyScreen.tsx'),   // the country directory
      join(SCREENS, 'vbg', 'VBGHomeScreen.tsx'),        // next of kin (and its sheet)
      join(SCREENS, 'booking', 'NoDetailScreen.tsx'),   // the safety hotline
    ];
    for (const s of sites) {
      const src = strip(s);
      const name = s.split(/[\\/]/).pop();
      expect(`${name}:dials`).toBe(`${name}:${/openURL\(\s*[`'"]tel:/.test(src)}`.replace('true', 'dials'));
      expect(`${name}:${/recordEmergencyCall\(/.test(src)}`).toBe(`${name}:true`);
    }
  });

  it('SOS is NOT recorded as a call — it places none', () => {
    /**
     * ⚠️ THE ONE THING THIS FEATURE MUST NOT DO. The panic/SOS lane raises an
     * alert to Ops; no call is dialled. Writing "Emergency call placed" into
     * the call history of a security app when no call happened is a false
     * record in exactly the log someone consults after an incident. SOS history
     * is server-side and belongs to ProtectionHistoryScreen.
     */
    const sosish = sourceFiles(SCREENS).filter(f => /SOS|Panic/i.test(f));
    expect(sosish.length).toBeGreaterThan(0);   // the scan must have something to check
    for (const f of sosish) {
      const name = f.split(/[\\/]/).pop();
      expect(`${name}:${/recordEmergencyCall\(/.test(strip(f))}`).toBe(`${name}:false`);
    }
  });
});
