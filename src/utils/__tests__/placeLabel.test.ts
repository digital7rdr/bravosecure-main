/**
 * Place-label shortening, exercised against the REAL strings from the founder's
 * device screenshots (August 2026 deck, pages 13 and 16). Rendering the stored
 * address verbatim is what stretched black bars across the map and repeated the
 * same line on every route-timeline row.
 */
import {shortPlaceLabel, placeWithContext, isNonLatin} from '../placeLabel';

// The exact value stored on the founder's booking.
const UAE = 'شارع العريف, Al Raha, Abu Dhabi, Abu Dhabi, United Arab Emirates';

describe('shortPlaceLabel', () => {
  it('reduces the founder\'s address to something a person would say', () => {
    expect(shortPlaceLabel(UAE)).toBe('Al Raha');
  });

  it('drops the country and the duplicated emirate', () => {
    expect(shortPlaceLabel('Marasi Drive, Business Bay, Dubai, Dubai, United Arab Emirates'))
      .toBe('Marasi Drive');
  });

  it('keeps a Latin street when there is one', () => {
    expect(shortPlaceLabel('Sheikh Zayed Road, Dubai, United Arab Emirates'))
      .toBe('Sheikh Zayed Road');
  });

  it('skips an Arabic-only component in favour of the next usable one', () => {
    expect(shortPlaceLabel('شارع العريف, Khalifa City, Abu Dhabi')).toBe('Khalifa City');
  });

  it('keeps a non-Latin name when it is all there is', () => {
    expect(shortPlaceLabel('شارع العريف')).toBe('شارع العريف');
  });

  it('caps long names on a word boundary rather than mid-word', () => {
    const full = 'Yas Marina Circuit Paddock Entrance Gate 3';
    const out = shortPlaceLabel(`${full}, Abu Dhabi`, 24);
    expect(out.length).toBeLessThanOrEqual(24);
    expect(out.endsWith('…')).toBe(true);
    // The kept text is a whole-word prefix: the original continues with a
    // space, so no word was sliced through.
    const kept = out.slice(0, -1);
    expect(full.startsWith(kept)).toBe(true);
    expect(full[kept.length]).toBe(' ');
  });

  it('is empty for empty input rather than throwing', () => {
    expect(shortPlaceLabel('')).toBe('');
    expect(shortPlaceLabel(null)).toBe('');
    expect(shortPlaceLabel(undefined)).toBe('');
  });

  it('never returns the whole original address for a UAE-shaped string', () => {
    // The regression this exists to prevent.
    expect(shortPlaceLabel(UAE)).not.toContain('United Arab Emirates');
    expect(shortPlaceLabel(UAE).length).toBeLessThan(UAE.length / 2);
  });
});

describe('placeWithContext', () => {
  it('gives one extra level for a prominent destination label', () => {
    expect(placeWithContext(UAE)).toBe('Al Raha · Abu Dhabi');
  });

  it('degrades to a single component when there is only one', () => {
    expect(placeWithContext('Al Raha, United Arab Emirates')).toBe('Al Raha');
  });

  it('stays bounded', () => {
    const out = placeWithContext('Yas Marina Circuit Paddock Entrance, Yas Island, Abu Dhabi', 34);
    expect(out.length).toBeLessThanOrEqual(34);
  });

  it('is empty for empty input', () => {
    expect(placeWithContext(null)).toBe('');
  });
});

describe('isNonLatin', () => {
  it('detects an Arabic-only string', () => {
    expect(isNonLatin('شارع العريف')).toBe(true);
  });

  it('treats a mixed string as Latin', () => {
    expect(isNonLatin('شارع Al Raha')).toBe(false);
  });

  it('is false for empty', () => {
    expect(isNonLatin('   ')).toBe(false);
  });
});
