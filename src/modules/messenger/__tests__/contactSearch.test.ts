/**
 * New Message search — the bar was a decorative <Text> with no state, so
 * typing filtered nothing. These are the matching rules behind the real
 * input, tested against the shapes the screen actually renders
 * (DiscoveredRow: localName + displayName; dev contacts: name).
 */
import {contactMatchesQuery, filterContacts} from '../contacts/contactSearch';

const rows = [
  {localName: 'Baine MTN',        displayName: 'Baine M',      phoneE164: '+27726366878'},
  {localName: 'Baine UAE DU',     displayName: 'Baine U',      phoneE164: '+971552676140'},
  {localName: 'Baine WORK UAE',   displayName: 'Baine W',      phoneE164: '+971502207578'},
  {localName: 'Inge UAE',         displayName: 'Inge',         phoneE164: '+971507026331'},
  {localName: 'Jacque Du Toit Work', displayName: 'Jacque',    phoneE164: '+971509918534'},
  {localName: 'Nadine du Toit',   displayName: 'Nadine',       phoneE164: '+971568951162'},
];

describe('contactSearch', () => {
  it('an empty or whitespace query keeps every contact', () => {
    expect(filterContacts(rows, '')).toHaveLength(rows.length);
    expect(filterContacts(rows, '   ')).toHaveLength(rows.length);
  });

  it('matches a name fragment case-insensitively, anywhere in the name', () => {
    expect(filterContacts(rows, 'baine').map(r => r.localName)).toEqual([
      'Baine MTN', 'Baine UAE DU', 'Baine WORK UAE',
    ]);
    expect(filterContacts(rows, 'WORK').map(r => r.localName)).toEqual([
      'Baine WORK UAE', 'Jacque Du Toit Work',
    ]);
    expect(filterContacts(rows, 'du toit').map(r => r.localName)).toEqual([
      'Jacque Du Toit Work', 'Nadine du Toit',
    ]);
  });

  it('matches the Bravo display name as well as the local address-book name', () => {
    // Users often save a contact under a nickname; searching the name
    // shown on their Bravo profile must still find them.
    expect(contactMatchesQuery(
      {localName: 'Mum', displayName: 'Jane Doe', phoneE164: '+971500000000'}, 'jane',
    )).toBe(true);
  });

  it('matches dev contacts, which carry `name` instead of localName', () => {
    expect(contactMatchesQuery({name: 'Alice (Dev)', phoneE164: '+15550000001'}, 'alice')).toBe(true);
  });

  it('ignores accents so "jose" finds "José"', () => {
    expect(contactMatchesQuery({localName: 'José Álvarez', phoneE164: '+34600000000'}, 'jose')).toBe(true);
    expect(contactMatchesQuery({localName: 'José Álvarez', phoneE164: '+34600000000'}, 'alvarez')).toBe(true);
  });

  describe('phone matching', () => {
    it('finds a number typed in any format, digits-only', () => {
      const expected = ['Baine UAE DU'];
      expect(filterContacts(rows, '+971552676140').map(r => r.localName)).toEqual(expected);
      expect(filterContacts(rows, '971552676140').map(r => r.localName)).toEqual(expected);
      expect(filterContacts(rows, '552676140').map(r => r.localName)).toEqual(expected);
      expect(filterContacts(rows, '552 676 140').map(r => r.localName)).toEqual(expected);
      expect(filterContacts(rows, '552-676-140').map(r => r.localName)).toEqual(expected);
    });

    it('drops a national leading zero so a locally-written number matches E.164', () => {
      // Users write "0552 676140"; the contact is stored "+971552676140".
      expect(filterContacts(rows, '0552676140').map(r => r.localName)).toEqual(['Baine UAE DU']);
    });

    it('matches a partial number as the user types', () => {
      expect(filterContacts(rows, '9715').map(r => r.localName)).toEqual([
        'Baine UAE DU', 'Baine WORK UAE', 'Inge UAE', 'Jacque Du Toit Work', 'Nadine du Toit',
      ]);
    });

    it('a lone "+" or "0" shows everything rather than nothing mid-typing', () => {
      expect(filterContacts(rows, '+')).toHaveLength(rows.length);
      expect(filterContacts(rows, '0')).toHaveLength(rows.length);
    });

    it('a mixed name+digits query still matches on the digits', () => {
      expect(filterContacts(rows, 'baine 5022').map(r => r.localName)).toEqual(['Baine WORK UAE']);
    });
  });

  it('returns nothing when there is genuinely no match', () => {
    expect(filterContacts(rows, 'zzzz')).toEqual([]);
    expect(filterContacts(rows, '99999999')).toEqual([]);
  });

  it('never mutates or reorders the source list', () => {
    const snapshot = rows.map(r => r.localName);
    const out = filterContacts(rows, '');
    expect(out).not.toBe(rows);
    expect(rows.map(r => r.localName)).toEqual(snapshot);
  });
});
