/**
 * Bravo OSINT intel source — the enriched news points on the Bravo Map.
 *
 * Contract: every country the prefs screen can select has a resolved map
 * pin (the server feed rows carry ISO2 regions, so a Bravo item NEVER
 * depends on headline-keyword geotag luck), and the row mapping preserves
 * the pin + real outlet name through to the IntelItem the map renders.
 */
jest.mock('@services/api', () => ({newsApi: {getFeed: jest.fn()}}));

import {NEWS_COUNTRIES, NEWS_CATEGORIES} from '../newsPrefs';
import {countryPin, geotag} from '../geotag';
import {clusterKey, clusterMarkers} from '../mapbox';
import {categoriesFor, toGuardianShape} from '../bravoNewsClient';
import {selectWorldExtras} from '../intelAggregator';
import {toIntelItem} from '../useIntelFeed';
import type {GuardianResult} from '../guardianClient';

describe('countryPin — guaranteed map pins', () => {
  it('covers EVERY selectable country', () => {
    const missing = NEWS_COUNTRIES
      .filter(c => c.code !== 'GLOBAL')
      .filter(c => countryPin(c.code) === null)
      .map(c => c.code);
    expect(missing).toEqual([]);
  });

  it('returns null for unknown codes and GLOBAL', () => {
    expect(countryPin('ZZ')).toBeNull();
    expect(countryPin('GLOBAL')).toBeNull();
    expect(countryPin(undefined)).toBeNull();
  });

  it('pins carry sane coordinates and the given label', () => {
    // ZA has a curated GEO row — its coords/label are CANONICAL.
    const za = countryPin('ZA', 'South Africa');
    expect(za).toEqual({lat: -26.2, lng: 28.05, label: 'SOUTH AFRICA'});
    for (const c of NEWS_COUNTRIES.filter(x => x.code !== 'GLOBAL')) {
      const pin = countryPin(c.code)!;
      expect(Math.abs(pin.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(pin.lng)).toBeLessThanOrEqual(180);
    }
  });

  it('agrees with headline geotagging for curated countries — one bubble per country', () => {
    // If these ever diverge, the same country renders as TWO bubbles whose
    // badge counts disagree with the tap drawer (founder report).
    expect(countryPin('AE')).toEqual(geotag('Explosion rocks Dubai marina'));
    expect(countryPin('SA')?.label).toBe('KSA');
    expect(clusterKey(countryPin('US')!)).toBe(clusterKey(geotag('Protests in New York')!));
  });
});

describe('cluster badge ↔ tap drawer consistency', () => {
  it('clusterMarkers counts match a regionHits-style grouping by the SAME key', () => {
    const markers = [
      {lat: 24.71, lng: 46.68, severity: 'HIGH' as const,   label: 'KSA'},
      {lat: 24.71, lng: 46.68, severity: 'MEDIUM' as const, label: 'KSA'},
      {lat: 24.71, lng: 46.68, severity: 'LOW' as const,    label: 'KSA'},
      {lat: 25.2,  lng: 55.27, severity: 'LOW' as const,    label: 'UAE'},
    ];
    const clusters = clusterMarkers(markers);
    const groups = new Map<string, number>();
    for (const m of markers) {groups.set(clusterKey(m), (groups.get(clusterKey(m)) ?? 0) + 1);}
    for (const c of clusters) {
      expect(c.count).toBe(groups.get(clusterKey(c)));
    }
    expect(clusters.find(c => c.label === 'KSA')?.count).toBe(3);
    expect(clusters.find(c => c.label === 'KSA')?.severity).toBe('HIGH');
  });
});

describe('geotag — full-globe headline coverage (Global feed must not cluster on Europe/MENA)', () => {
  it('resolves countries far outside the curated hotspot table', () => {
    expect(geotag('Floods displace thousands in Indonesia')).toEqual({lat: -6.21, lng: 106.85, label: 'INDONESIA'});
    expect(geotag('Peru declares state of emergency after quake')?.label).toBe('PERU');
    expect(geotag('Fiji hosts Pacific security summit')?.label).toBe('FIJI');
    expect(geotag('Cartel violence flares in Ecuador')?.label).toBe('ECUADOR');
  });

  it('the curated table still wins for its city-level aliases', () => {
    expect(geotag('Explosion rocks Dubai marina')?.label).toBe('UAE');
    expect(geotag('Strikes reported near Kyiv')?.label).toBe('UKRAINE');
  });

  it('common alias forms resolve', () => {
    expect(geotag('Czechia elects a new president')?.label).toBe('CZECH REPUBLIC');
    expect(geotag('Burma junta extends emergency')?.label).toBe('MYANMAR');
  });

  it('still null when nothing geographic is named', () => {
    expect(geotag('Central bank holds rates steady')).toBeNull();
  });
});

describe('toGuardianShape → toIntelItem', () => {
  const row = {
    id: 'gnabc', title: 'Metro line opens in Riyadh', summary: 'Phase two',
    url: 'https://arabnews.com/x', source: 'Arab News', region: 'SA',
    category: 'Top Stories', published_at: new Date().toISOString(),
  };

  it('maps a feed row with a resolved country pin + real outlet tag', () => {
    const g = toGuardianShape(row);
    expect(g.id).toBe('bravo-gnabc');
    // SA has a curated GEO row → canonical coords + 'KSA' label.
    expect(g.geo).toEqual({lat: 24.71, lng: 46.68, label: 'KSA'});
    expect(g.sourceTag).toBe('ARAB NEWS');
    expect(g.sectionId).toBe('top');
  });

  it('the resolved pin WINS over headline geotagging in the intel item', () => {
    // Headline names the UK — but the row is Saudi press about Saudi Arabia;
    // the map point must land on SA, not on a keyword guess.
    const item = toIntelItem(toGuardianShape({...row, title: 'UK investors eye Riyadh metro'}));
    expect(item.lat).toBe(24.71);
    expect(item.lng).toBe(46.68);
    expect(item.loc).toBe('📍 KSA');
    expect(item.src).toBe('SOURCE: ARAB NEWS');
  });

  it('GLOBAL rows carry no forced pin (fall back to headline geotag)', () => {
    const g = toGuardianShape({...row, region: 'GLOBAL', title: 'Markets rally in France'});
    expect(g.geo).toBeUndefined();
    expect(toIntelItem(g).loc).toBe('📍 FRANCE');
  });

  it('wire filters map to server category ids', () => {
    // Founder 2026-08-09 — the Bravo Feed chips ARE the News Filter
    // categories, so a chip maps to ITSELF and this stopped being a
    // translation table. ALL still sends '' so the server blends the user's
    // saved selection.
    expect(categoriesFor('security')).toBe('security');
    expect(categoriesFor('defence')).toBe('defence');
    expect(categoriesFor('finance')).toBe('finance');
    expect(categoriesFor('realestate')).toBe('realestate');
    expect(categoriesFor('ALL')).toBe('');
  });

  it('every News Filter category is a valid chip (the two lists cannot drift)', () => {
    // The whole point of the rename: one vocabulary across both surfaces.
    for (const c of NEWS_CATEGORIES) {
      expect(categoriesFor(c.id)).toBe(c.id);
    }
  });
});

describe('selectWorldExtras — the phase-two map layer', () => {
  const g = (id: string, title: string, url: string): GuardianResult => ({
    id, webTitle: title, webUrl: url, sectionId: 'top', sectionName: 'Top',
    webPublicationDate: new Date().toISOString(),
  });

  it('keeps only sweep items not already on the wire list', () => {
    const results = [g('1', 'Flood hits Jakarta suburbs', 'https://a/1')];
    const world = [
      g('w1', 'Flood hits Jakarta suburbs', 'https://b/dup-title'),
      g('w2', 'Lagos port expansion approved', 'https://b/2'),
    ];
    const extras = selectWorldExtras('ALL', results, world);
    expect(extras.map(e => e.id)).toEqual(['w2']);
  });

  it('a keyword-backed chip gates world rows through its category filter', () => {
    // Was the CRITICAL severity chip, which no longer exists. The guarantee is
    // unchanged: chips with no server section must still scope the worldwide
    // sweep, or the map fills with rows the chip never asked for.
    const world = [
      g('w1', 'Navy missile strike reported off the coast', 'https://b/3'),
      g('w2', 'Quiet market day in Nairobi', 'https://b/4'),
    ];
    const extras = selectWorldExtras('defence', [], world);
    expect(extras.map(e => e.id)).toEqual(['w1']);
  });

  it('a section-backed chip does NOT keyword-gate (the server already scoped it)', () => {
    const world = [
      g('w1', 'Quiet market day in Nairobi', 'https://b/5'),
      g('w2', 'Cabinet reshuffle announced', 'https://b/6'),
    ];
    expect(selectWorldExtras('world', [], world).map(e => e.id)).toEqual(['w1', 'w2']);
  });
});
