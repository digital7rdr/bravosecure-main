/**
 * Item H — incident client completion (M10 multi-evidence/video/drafts + A8
 * queue filters). Source scans (RN screens can't mount in this project),
 * comment-stripped line-safe, CRLF-normalised, fail-closed anchors.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const DIR = join(process.cwd(), 'src', 'screens', 'deptchat');

function read(f: string): string {
  return readFileSync(join(DIR, f), 'utf8').replace(/\r\n/g, '\n');
}
function strip(s: string): string {
  return s
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
}

describe('M10 — evidence array, caps, and the sequential seal loop', () => {
  it('media is an ARRAY capped at 5, with size and duration gates', () => {
    const src = strip(read('ReportIncidentDetailsScreen.tsx'));
    expect(src).toMatch(/const MAX_MEDIA = 5/);
    expect(src).toMatch(/const MAX_BYTES = 50 \* 1024 \* 1024 - 49/);
    expect(src).toMatch(/const MAX_VIDEO_SECONDS = 60/);
    // The gates run on the ASSET metadata, before any bytes are read
    // (readUriBytes holds ~2.3x the file in RAM — the cap must precede it).
    expect(src).toMatch(/a\.fileSize > MAX_BYTES/);
    expect(src).toMatch(/a\.duration > MAX_VIDEO_SECONDS/);
    // Camera video capture carries the hard duration limit.
    expect(src).toMatch(/durationLimit: MAX_VIDEO_SECONDS/);
    // Library multi-pick is capped to the REMAINING slots.
    expect(src).toMatch(/selectionLimit: remaining/);
  });

  it('uploads run SEQUENTIALLY with a per-item catch — one bad file never aborts the rest', () => {
    const src = strip(read('ReportIncidentDetailsScreen.tsx'));
    // `pending` since the in-place-retry restructure: the loop re-runs over
    // the failed subset on Retry, same sequential+caught shape.
    const start = src.indexOf('for (const m of pending)');
    expect(start).toBeGreaterThan(-1);
    const loop = src.slice(start, src.indexOf('}', src.indexOf('.catch', start)) + 1);
    expect(loop).toMatch(/await uploadAndSealEvidence\(data\.id, m\.uri, m\.mime\)/);
    expect(loop).toMatch(/\.catch\(/);
    // No parallel fan-out of the seal pipeline (five whole-file RAM copies).
    expect(src).not.toMatch(/Promise\.all\([^)]*uploadAndSealEvidence/);
    // The aggregate is honest: partial success says how many made it (the
    // retry restructure computes it from the failed subset).
    expect(src).toMatch(/media\.length - failed\.length/);
    expect(src).toMatch(/of \$\{media\.length\} attachment/);
  });

  it('the draft is cleared ONLY after the submit POST resolved', () => {
    const src = strip(read('ReportIncidentDetailsScreen.tsx'));
    const submitPos = src.indexOf('await incidentApi.submit(');
    const clearPos = src.indexOf('await clearIncidentDraft(');
    expect(submitPos).toBeGreaterThan(-1);
    expect(clearPos).toBeGreaterThan(-1);
    // Clearing BEFORE the POST eats the draft on a failed submit — the
    // blueprint's pinned RED mutation.
    expect(clearPos).toBeGreaterThan(submitPos);
    // And never CALLED before it (the import line naturally sits above —
    // anchor on the call form, not the bare name).
    const preSubmit = src.slice(0, submitPos);
    expect(preSubmit).not.toMatch(/clearIncidentDraft\(/);
  });

  it('the RESURRECTION race is dead: latch + timer cancel precede the clear', () => {
    // A timer armed by the last keystroke fired mid-upload and re-saved the
    // cleared draft, whose resume card then re-filed a duplicate incident
    // (both reviewers). The latch must be SET and the timer KILLED before
    // clearIncidentDraft, and the timer callback must check the latch (edits
    // during the upload loop re-arm the effect).
    const src = strip(read('ReportIncidentDetailsScreen.tsx'));
    const clearPos = src.indexOf('await clearIncidentDraft(');
    const pre = src.slice(0, clearPos);
    expect(pre).toMatch(/submittedRef\.current = true/);
    expect(pre).toMatch(/clearTimeout\(draftTimer\.current\)/);
    // Inside the timer callback: bail when submitted.
    const timerCb = src.slice(src.indexOf('draftTimer.current = setTimeout'), src.indexOf('}, 800)'));
    expect(timerCb).toMatch(/if \(submittedRef\.current\) \{return;\}/);
    // And submit itself refuses re-entry after success.
    expect(src).toMatch(/if \(busy \|\| submittedRef\.current\) \{return;\}/);
  });

  it('partial failure offers a REAL recovery: in-place Retry over the same incident', () => {
    // The old copy said "re-open the report and add them again" — an
    // affordance no screen offers (critic).
    const src = strip(read('ReportIncidentDetailsScreen.tsx'));
    expect(src).toMatch(/\{text: 'Retry', onPress: \(\) => \{ void sealBatch\(\); \}\}/);
    expect(src).not.toMatch(/re-open the report/);
  });

  it('the seal pipeline has a post-read size backstop (nullish fileSize is only advisory)', () => {
    const src = strip(readFileSync(join(DIR, 'incidentEvidence.ts'), 'utf8').replace(/\r\n/g, '\n'));
    expect(src).toMatch(/bytes\.byteLength > 50 \* 1024 \* 1024 - 49/);
    expect(src).toMatch(/'too-big'/);
  });

  it('drafts die on logout', () => {
    const draft = strip(readFileSync(join(DIR, 'incidentDraft.ts'), 'utf8').replace(/\r\n/g, '\n'));
    expect(draft).toMatch(/export async function clearAllIncidentDrafts/);
    const auth = strip(readFileSync(join(process.cwd(), 'src', 'store', 'authStore.ts'), 'utf8').replace(/\r\n/g, '\n'));
    expect(auth).toMatch(/clearAllIncidentDrafts/);
  });

  it('drafts persist URIs only — never bytes, never base64', () => {
    const draft = strip(readFileSync(join(DIR, 'incidentDraft.ts'), 'utf8').replace(/\r\n/g, '\n'));
    expect(draft).toMatch(/uri: string/);
    for (const banned of ['base64', 'readUriBytes', 'Buffer']) {
      expect(`${banned}:${draft.includes(banned)}`).toBe(`${banned}:false`);
    }
    // Keyed per user — a shared device must not leak drafts across accounts.
    expect(draft).toMatch(/KEY_PREFIX\}\$\{userId\}/);
  });

  it('the resume card validates the draft against the live category/severity sets', () => {
    const src = strip(read('ReportIncidentCategoryScreen.tsx'));
    // vs2 item 4 — the draft key gained the ORG. Keyed by user alone, an
    // abandoned Acme draft was offered inside Borealis and Submit filed it
    // there, and it outlived the session because AsyncStorage persists while
    // the workspace context deliberately does not.
    expect(src).toMatch(/loadIncidentDraft\(userId, activeOrgId\)/);
    expect(src).toMatch(/INCIDENT_CATEGORY_META\[d\.category as IncidentCategoryDto\]/);
    expect(src).toMatch(/Resume draft\?/);
    expect(src).toMatch(/clearIncidentDraft\(userId, activeOrgId\)/);
  });
});

describe('M10 — video renders as VIDEO', () => {
  it('EvidenceSection branches on the decrypted mime and uses expo-video', () => {
    const src = strip(read('EvidenceSection.tsx'));
    // The pinned RED mutation: "video always rendered as Image".
    expect(src).toMatch(/from 'expo-video'/);
    expect(src).toMatch(/mime\.startsWith\('video\/'\)/);
    expect(src).toMatch(/<EvidenceVideo/);
    expect(src).toMatch(/<VideoView/);
    // The image branch survives.
    expect(src).toMatch(/<Image key=\{att\.id\}/);
  });

  it('loadEvidenceUri returns the mime alongside the uri', () => {
    const src = strip(readFileSync(join(DIR, 'incidentEvidence.ts'), 'utf8').replace(/\r\n/g, '\n'));
    expect(src).toMatch(/Promise<\{uri: string; mime: string\} \| null>/);
  });
});

describe('A8 — queue filters wired to the server params', () => {
  it('category, from (presets) and department all reach incidentApi.queue', () => {
    const src = strip(read('IncidentQueueScreen.tsx'));
    const call = src.slice(src.indexOf('incidentApi.queue({'), src.indexOf('});', src.indexOf('incidentApi.queue({')));
    expect(call).toMatch(/category: cat/);
    expect(call).toMatch(/from: new Date\(/);
    expect(call).toMatch(/department: dept/);
  });

  it('the new rows keep the B-190 shape: horizontal, explicit height, marginBottom gap', () => {
    const src = strip(read('IncidentQueueScreen.tsx'));
    expect((src.match(/<ScrollView\s+horizontal/g) ?? []).length).toBeGreaterThanOrEqual(4);
    for (const name of ['catScroll', 'rangeScroll']) {
      const m = src.match(new RegExp(`${name}: \\{([^}]*)\\}`));
      expect(m).toBeTruthy();
      expect((m as RegExpMatchArray)[1]).toMatch(/height: \d+/);
      expect((m as RegExpMatchArray)[1]).toMatch(/marginBottom: \d+/);
      expect((m as RegExpMatchArray)[1]).not.toMatch(/paddingBottom/);
    }
  });
});
