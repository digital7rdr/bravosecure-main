/**
 * PDF §13 checklist line 9 — "Admins can choose the names of levels."
 *
 * Channel names were already free text. The TIER vocabulary was not: it was
 * hardcoded in FOUR places that had already drifted — ManageChannelsScreen's
 * `LEVEL_NOUN`, an inline copy in ChannelEditorScreen, the upper-cased
 * `'LEVEL 1 — ENTERPRISE'` headers on the agency member screen (keyed on the
 * 0-based `level` while the others keyed on it as the display tier, so the
 * three disagreed on screen), and the `Ln` pill that said "L2" beside a row
 * labelled "Main".
 *
 * So the risk here is not "does renaming work" — it is that renaming must be
 * PRESENTATION ONLY, and that the fallback must be invisible to every org that
 * never chooses a name. Both are pinned below.
 */
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {
  nameForTier, tierFromLevel, normaliseLevelNames,
  DEFAULT_LEVEL_NAMES, MAX_LEVEL_NAME, MAX_NAMED_TIER,
} from '../levelNames';

describe('nameForTier', () => {
  it('falls back to the built-ins when the org has chosen nothing', () => {
    // The invisible-by-default property. Every org today has [] stored, so if
    // this were wrong the rename feature would have silently changed the
    // vocabulary for all of them.
    for (const [i, want] of DEFAULT_LEVEL_NAMES.entries()) {
      expect(nameForTier(i + 1, [])).toBe(want);
      expect(nameForTier(i + 1, undefined)).toBe(want);
      expect(nameForTier(i + 1, null)).toBe(want);
    }
  });

  it('uses the admin name when there is one', () => {
    expect(nameForTier(1, ['Region'])).toBe('Region');
    expect(nameForTier(2, ['Region', 'Branch'])).toBe('Branch');
  });

  it('fills the REST from the built-ins — renaming L1 alone is legal', () => {
    // A short array must not blank the tiers it does not mention; that is what
    // lets an admin rename one tier without inventing names for the others.
    const chosen = ['Region'];
    expect(nameForTier(1, chosen)).toBe('Region');
    expect(nameForTier(2, chosen)).toBe(DEFAULT_LEVEL_NAMES[1]);
    expect(nameForTier(4, chosen)).toBe(DEFAULT_LEVEL_NAMES[3]);
  });

  it('treats a BLANK entry as unset, not as an unnamed tier', () => {
    // The editor lets a field be cleared, and a cleared field means "back to
    // the default". Rendering an empty string would give a row no tier at all.
    expect(nameForTier(2, ['Region', '   '])).toBe(DEFAULT_LEVEL_NAMES[1]);
  });

  it('clamps out-of-range rather than returning undefined', () => {
    // A tier past MAX is reachable only through masked ancestry. An unlabelled
    // row is worse than a slightly-wrong one.
    expect(nameForTier(0, [])).toBe(DEFAULT_LEVEL_NAMES[0]);
    expect(nameForTier(99, [])).toBe(DEFAULT_LEVEL_NAMES[MAX_NAMED_TIER - 1]);
    expect(nameForTier(Number.NaN, [])).toBe(DEFAULT_LEVEL_NAMES[0]);
  });
});

describe('tierFromLevel', () => {
  it('maps the 0-based stored column onto a 1-based display tier', () => {
    expect(tierFromLevel(0)).toBe(1);
    expect(tierFromLevel(1)).toBe(2);
    expect(tierFromLevel(3)).toBe(4);
  });

  it('defaults a missing level the way the screens always did', () => {
    // Pre-hierarchy rows carry no level and have always read as "Main".
    expect(nameForTier(tierFromLevel(null), [])).toBe('Main');
    expect(nameForTier(tierFromLevel(undefined), [])).toBe('Main');
  });

  it('clamps rather than inventing a fifth tier', () => {
    expect(tierFromLevel(9)).toBe(MAX_NAMED_TIER);
  });
});

describe('normaliseLevelNames', () => {
  it('drops TRAILING blanks so "renamed L1 only" stores one entry', () => {
    // Storing ['Region','','',''] would work but reads as four decisions when
    // the admin made one, and it is what the server would audit.
    expect(normaliseLevelNames(['Region', '', '', ''])).toEqual(['Region']);
  });

  it('KEEPS an interior blank — position is meaningful', () => {
    // ['', 'Branch'] means "default L1, rename L2". Compacting it would move
    // Branch to L1 and silently rename the wrong tier.
    expect(normaliseLevelNames(['', 'Branch'])).toEqual(['', 'Branch']);
  });

  it('an all-blank array clears back to the built-ins', () => {
    // This is what makes the editor's clear-to-reset work without a separate
    // reset action.
    expect(normaliseLevelNames(['', '  ', ''])).toEqual([]);
  });

  it('trims and caps, and never exceeds the tier count', () => {
    expect(normaliseLevelNames(['  Region  '])).toEqual(['Region']);
    expect(normaliseLevelNames(['x'.repeat(80)])[0]).toHaveLength(MAX_LEVEL_NAME);
    expect(normaliseLevelNames(['a', 'b', 'c', 'd', 'e'])).toHaveLength(MAX_NAMED_TIER);
  });

  it('survives null/undefined entries', () => {
    expect(normaliseLevelNames([null, undefined, 'Team'])).toEqual(['', '', 'Team']);
  });
});

/**
 * The single-source scan. Four drifted copies is what this replaced; a fifth is
 * how it comes back.
 */
describe('the tier vocabulary lives in exactly one module', () => {
  const SCREENS = join(process.cwd(), 'src', 'screens');
  const HELPER = join(SCREENS, 'deptchat', 'levelNames.ts');

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === '__tests__') {continue;}
        sourceFiles(p, out);
      } else if (/\.tsx?$/.test(entry) && p !== HELPER) {
        out.push(p);
      }
    }
    return out;
  }

  /** CRLF-normalised, comments stripped LINE-ANCHORED — a `\n` anchor matches
   *  nothing on this repo's CRLF files and an absence scan then passes
   *  vacuously, and prose quoting the banned words is the usual false hit. */
  function strip(path: string): string {
    const lines = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const out: string[] = [];
    let inBlock = false;
    for (const line of lines) {
      const t = line.trim();
      if (inBlock) { if (t.endsWith('*/')) {inBlock = false;} continue; }
      if (t.startsWith('/*')) { if (!t.endsWith('*/')) {inBlock = true;} continue; }
      if (t.startsWith('//') || t.startsWith('*')) {continue;}
      out.push(line);
    }
    return out.join('\n');
  }

  it('no screen re-declares the Enterprise/Main/Sub vocabulary', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(SCREENS)) {
      const src = strip(f);
      // The FORMULA, not the name: two of these words adjacent in an array or
      // a string is the shape every one of the four copies took.
      if (/'Enterprise'\s*,\s*'Main'/.test(src)
        || /'Main'\s*,\s*'Sub'/.test(src)
        || /LEVEL \d+ — (ENTERPRISE|MAIN|SUB)/.test(src)) {
        offenders.push(f.replace(process.cwd(), ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('and the screens that show a tier name consume the helper', () => {
    // The POSITIVE half — banning copies proves nothing if the real consumers
    // quietly stopped rendering a name at all.
    for (const rel of [
      ['deptchat', 'ManageChannelsScreen.tsx'],
      ['deptchat', 'ChannelEditorScreen.tsx'],
      ['messenger', 'DepartmentChannelsScreen.tsx'],
    ]) {
      const src = strip(join(SCREENS, ...rel));
      const name = rel[1];
      expect(`${name}:${/nameForTier\(/.test(src)}`).toBe(`${name}:true`);
    }
  });
});
