/**
 * Locked product + operations terminology (Testing Issues V2, PDF p.5, and
 * Issues 23 / 33 / 35).
 *
 *   Client-facing operations term  ->  "Bravo Control System"
 *     BANNED in client copy: "Ops Room", "Control Room", "Ops Room Review",
 *     "Awaiting Ops Approval", "Ops Room Notified".
 *   Secure Services plans          ->  "Bravo Secure Lite" / "Bravo Secure Pro"
 *     BANNED: bare "Bravo Pro" — it does not say which BRAVO family it is.
 *   A registered security company  ->  "Service Provider"
 *     BANNED here: "Enterprise", which is reserved for corporate /
 *     Department Chat account contexts.
 *
 * SCOPE — client-facing screens only. The PDF says internal console labels are
 * "separately reviewed", and CPO/agent surfaces are operator-facing. In
 * particular AssignedMissionDetailScreen's "Open Ops Room" names the mission
 * CHAT ROOM, not the operations team, so renaming it to "Bravo Control System"
 * would be actively wrong. Those are listed in OPERATOR_FACING below with the
 * reason, so the omission is a decision on the record rather than an oversight.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

/** Client-facing screens: what a paying client can see. */
const CLIENT_FACING = [
  'screens/ops/OpsRoomReviewScreen.tsx',
  'screens/liveops/SOSScreen.tsx',
  'screens/dashboard/DashboardScreen.tsx',
  'screens/booking/AddOnsScreen.tsx',
  'screens/booking/CustomizeAddOnsScreen.tsx',
  'screens/vbg/VBGHomeScreen.tsx',
  'screens/vbg/VBGSRAScreen.tsx',
  'screens/vbg/VbgScanPrompt.tsx',
  'screens/pro/tierMatrix.ts',
  'screens/auth/RoleSelectionScreen.tsx',
  'screens/auth/HomeSelectionScreen.tsx',
  'screens/settings/ProfileScreen.tsx',
  'components/ProfileDrawerModal.tsx',
  'store/entitlements.ts',
  // Bravo Secure Pro application flow (request-and-approval custom plans).
  'screens/securepro/SecureServicesScreen.tsx',
  'screens/securepro/SecureProIntroScreen.tsx',
  'screens/securepro/SecureProApplyScreen.tsx',
  'screens/securepro/SecureProStatusScreen.tsx',
  'screens/securepro/SecureProProposalScreen.tsx',
  'screens/securepro/SecureProPaymentScreen.tsx',
  'screens/securepro/proStatus.ts',
];

/**
 * Deliberately OUT of scope — operator surfaces, or where "Ops Room" names the
 * mission chat room rather than the operations team. Revisit only with a
 * product-owner decision (fix plan §10 Q2).
 */
const OPERATOR_FACING = [
  ['screens/cpo/AssignedMissionDetailScreen.tsx', 'CPO: "Open Ops Room" is the mission CHAT ROOM'],
  ['screens/agent/AgentDeploymentRequirementsScreen.tsx', 'agent: "Awaiting Ops Sign-off"'],
  ['screens/agent/OrgMissionsScreen.tsx', 'agency: crew-dispatch confirmation copy'],
] as const;

/**
 * Rendered COPY only. Strips comments line-wise — the naive
 * `/\/\*[\s\S]*?\*\//g` form treats a literal `/` + `*` inside a CSS or MIME
 * token as a comment OPEN and silently eats real code.
 */
function copy(rel: string): string {
  const src = readFileSync(join(ROOT, 'src', rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) {inBlock = false;}
      continue;
    }
    // `{/*` too — a JSX comment is still a comment, and missing it made this
    // scan flag prose rather than copy.
    if (trimmed.startsWith('/*') || trimmed.startsWith('{/*')) {
      if (!trimmed.includes('*/')) {inBlock = true;}
      continue;
    }
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

describe('Issue 33 — client-facing copy says "Bravo Control System"', () => {
  it.each(CLIENT_FACING)('%s contains no "Ops Room" / "Control Room"', rel => {
    const src = copy(rel);
    expect(src).not.toMatch(/Ops Room/i);
    expect(src).not.toMatch(/Control Room/i);
    expect(src).not.toMatch(/operations room/i);
  });

  it('the review screen uses the approved wording throughout', () => {
    const src = copy('screens/ops/OpsRoomReviewScreen.tsx');
    expect(src).toContain('BRAVO CONTROL SYSTEM REVIEW');
    expect(src).toContain('AWAITING BRAVO CONTROL SYSTEM APPROVAL');
    // The locked "WAITING FOR BRAVO CONTROL SYSTEM" footer bar was a FOURTH
    // telling of the same status and was removed (dev-feedback screen 01,
    // 2026-08-18) — opsReviewLayout.test.ts pins that it stays removed. The
    // terminology rule this suite guards lives on in the cancel note below.
    expect(src).toContain('Bravo Control System assigns your detail');
  });

  it('SOS never claims a room notified it', () => {
    const src = copy('screens/liveops/SOSScreen.tsx');
    // Issue 44 superseded the flat "…Notified" line: the app must not assert
    // ops HAVE the alert until acknowledged_at lands. Both replacement strings
    // still carry the approved term, which is what this suite guards.
    expect(src).toContain('Bravo Control System Acknowledged');
    expect(src).toContain('Waiting for Bravo Control System');
    expect(src).toContain('Bravo Control System On Standby');
  });
});

describe('Issue 23 — Secure Services plans carry the locked names', () => {
  it.each(CLIENT_FACING)('%s has no bare "Bravo Pro"', rel => {
    const src = copy(rel);
    // Matches "Bravo Pro" only when NOT already "Bravo Secure Pro" /
    // "Bravo Messenger Pro".
    expect(src).not.toMatch(/Bravo Pro\b/);
  });

  it('the tier matrix keeps the two product families apart', () => {
    const src = copy('screens/pro/tierMatrix.ts');
    // The MESSENGER subscription ladder must carry the Messenger family name…
    expect(src).toMatch(/pro:\s*'Bravo Messenger Pro'/);
    // …the Secure Services product plans keep the locked Secure name…
    expect(src).toMatch(/title:\s*'Bravo Secure Pro'/);
    // …and the old overlap (the messenger tier labelled as the Secure plan)
    // must never come back.
    expect(src).not.toMatch(/pro:\s*'Bravo Secure Pro'/);
  });
});

describe('Issue 35 — a security company is a Service Provider, not "Enterprise"', () => {
  it('the provider profile-type card and its CTA both say Service Provider', () => {
    const src = copy('screens/agent/AgentTypeSelectScreen.tsx');
    expect(src).toMatch(/title:\s*'Service Provider'/);
    expect(src).toMatch(/cta:\s*'Continue as Service Provider'/);
    expect(src).not.toMatch(/'Enterprise'/);
    expect(src).not.toMatch(/Continue as Enterprise/);
  });

  it('the wire contract is unchanged — only the LABEL moved', () => {
    const src = copy('screens/agent/AgentTypeSelectScreen.tsx');
    // Renaming the id or the backend mapping would break provider creation.
    expect(src).toMatch(/id:\s*'agency'/);
    expect(src).toContain('uiTypeToBackend(selected)');
  });

  it('Department Chat keeps its ENTERPRISE label — the term is reserved, not banned', () => {
    // Founder 2026-08-05 — the Departmental Chat entry moved from the Groups
    // screen to the profile drawer. The label is what this pin protects, and it
    // moved with it; the assertion follows the label rather than being deleted.
    expect(copy('components/ProfileDrawerModal.tsx')).toMatch(/ENTERPRISE/);
  });
});

describe('operator-facing surfaces are a recorded exclusion, not an oversight', () => {
  it.each(OPERATOR_FACING)('%s still says Ops (%s)', (rel) => {
    // If one of these is ever migrated, delete its row here WITH a product-owner
    // decision — do not silently widen the sweep.
    expect(copy(rel)).toMatch(/Ops/);
  });
});
