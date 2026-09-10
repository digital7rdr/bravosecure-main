/**
 * Shared threat classification for the VBG intel sources (GDELT, NewsData,
 * RSS, …). One severity vocabulary so every source maps the same way.
 */
export type ThreatSeverity = 'critical' | 'caution' | 'information';

export interface ThreatItem {
  title:    string;
  url:      string;
  source:   string;     // domain / provider
  seenAt:   string;     // ISO
  severity: ThreatSeverity;
  /** Matched threat theme, e.g. "hijacking". */
  theme:    string;
}

// Theme -> severity. CRITICAL = violent/armed/deadly; CAUTION = unrest /
// property / disruption; everything else surfaces as INFORMATION.
// Vocabulary kept broad so REAL local incidents (a market fire, a militant
// raid, a road accident, a kidnapping) are caught — not just the narrow
// crime set — while non-incident news (diplomacy, sport, history) stays
// INFORMATION and is filtered out of the threat score.
export const THEME_BUCKETS: Array<{severity: ThreatSeverity; words: string[]}> = [
  {severity: 'critical', words: [
    'hijack', 'kidnap', 'abduct', 'shooting', 'shootout', 'gunfire', 'shot dead', 'opened fire',
    'armed robbery', 'gunpoint', 'stabbing', 'stabbed', 'murder', 'killed', 'dead', 'fatal',
    'terror', 'terrorist', 'militant', 'insurgent', 'bombing', 'bomb ', 'blast', 'explosion',
    'grenade', 'suicide attack', 'suicide bomb', 'ambush', 'gun attack', 'firing', 'acid attack',
    'assault', 'hostage', 'massacre', 'lynch', 'beheaded', 'gang ', 'air strike', 'airstrike', 'shelling',
  ]},
  {severity: 'caution',  words: [
    'robbery', 'robbed', 'mugging', 'theft', 'stolen', 'looting', 'carjack', 'snatching', 'burglary', 'dacoity',
    'protest', 'rally', 'riot', 'unrest', 'clash', 'demonstration', 'strike', 'shutdown', 'sit-in', 'blockade',
    'curfew', 'arrested', 'detained', 'raid', 'crackdown', 'vandal', 'arson', 'fire', 'blaze',
    'accident', 'crash', 'collision', 'stampede', 'drug bust', 'smuggling', 'extortion', 'harassment', 'molest', 'rape',
  ]},
];

/** Every theme word OR-joined — used to build a single upstream query. */
export const ALL_THEME_WORDS = THEME_BUCKETS.flatMap(b => b.words);

// Words that are too generic to stand alone as a threat (avoid false positives
// like "dead heat", "fire sale", "strike a deal"). Require a stronger context
// word nearby OR skip them when they appear in clearly non-incident phrasing.
const AMBIGUOUS = new Set(['dead', 'fire', 'strike', 'gang ', 'bomb ', 'firing', 'crash', 'fatal', 'rally']);
// Phrases that make an ambiguous keyword benign. Note "market" is qualified
// (stock/share market) — a bare "supermarket" must NOT suppress a real fire.
// Health/medical idioms added 2026-08-01 (founder SRA relevance report):
// "killer cholesterol … prevent fatal heart attack" was scoring CRITICAL via
// the ambiguous 'fatal'. Only AMBIGUOUS words are suppressed — a shooting at
// a hospital still classifies via its unambiguous keywords.
const SAFE_CONTEXT = /\b(deal|sale|heat|peace talks?|trade talks?|drill|cricket|football|match|win|won|hat-?trick|economy|economic|stock\s*market|share\s*market|market\s*rally|stock\s*rally|sensex|nifty|rupee|box office|film|movie|album|concert|festival|wedding|health|medical|cholesterol|heart attack|cancer|diabetes|disease|obesity|diet|vaccine|therapy|symptom|wellness)\b/;

// Word-START boundary match: the keyword must begin a word (so "fire" does
// NOT match "ceasefire" and "raid" does NOT match "afraid"/"trade"), but the
// END is open so a stem still matches its inflections ("protest" → "protesters",
// "riot" → "rioters", "kill" handled via "killed"). Multi-word phrases and
// trailing-space tokens fall back to substring.
function hasWord(haystack: string, word: string): boolean {
  const w = word.trim();
  if (w.includes(' ')) {return haystack.includes(word);}      // phrase / spaced token
  return new RegExp(`(^|[^a-z])${w}`, 'i').test(haystack);
}

export function classifyThreat(title: string): {severity: ThreatSeverity; theme: string} {
  const t = (title ?? '').toLowerCase();
  // Guard: if the headline is clearly non-incident (sport/markets/film), don't
  // let an ambiguous word ("fire sale", "stock market rally") flag a threat.
  const benign = SAFE_CONTEXT.test(t);
  for (const bucket of THEME_BUCKETS) {
    const hit = bucket.words.find(w => {
      if (!hasWord(t, w)) {return false;}
      if (benign && AMBIGUOUS.has(w)) {return false;}
      return true;
    });
    if (hit) {return {severity: bucket.severity, theme: hit.trim()};}
  }
  return {severity: 'information', theme: 'advisory'};
}
