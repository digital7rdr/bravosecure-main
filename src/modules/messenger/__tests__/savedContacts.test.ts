/**
 * "Is this number saved on my phone?" — the address-book lookup behind the
 * Chat Info chip.
 *
 * The rules that matter here are the two that protect the USER from a wrong
 * answer, not the happy path:
 *
 *  1. **Unknown is not 'not-saved'.** Reading contacts needs permission. If it
 *     is denied or the module is unavailable, the screen must show nothing —
 *     a wrong "Not in contacts · Save" badge pushes people into creating
 *     duplicates of contacts they already have.
 *  2. **Never prompt from a render.** The badge is drawn whenever Chat Info
 *     opens; if the lookup asked for permission it would raise a system dialog
 *     on a screen the user merely navigated to.
 *
 * The tail match is the third: address books store numbers in inconsistent
 * shapes ("+8801711…", "01711…", "01 71 …"), and a full-string compare is the
 * single most common way a genuinely-saved contact reads as unsaved.
 */

const mockGetPermissions = jest.fn();
const mockRequestPermissions = jest.fn();
const mockGetContacts = jest.fn();
const mockPresentForm = jest.fn();

jest.mock('expo-contacts', () => ({
  getPermissionsAsync:     (...a: unknown[]) => mockGetPermissions(...a),
  requestPermissionsAsync: (...a: unknown[]) => mockRequestPermissions(...a),
  getContactsAsync:        (...a: unknown[]) => mockGetContacts(...a),
  presentFormAsync:        (...a: unknown[]) => mockPresentForm(...a),
  PermissionStatus: {GRANTED: 'granted', DENIED: 'denied'},
  ContactTypes:     {Person: 'person'},
  Fields:           {PhoneNumbers: 'phoneNumbers', Name: 'name'},
}));

import {
  getSavedState,
  presentSaveContact,
  invalidateSavedContacts,
  _resetSavedContactsForTests,
} from '../contacts/savedContacts';

function granted(numbers: string[]): void {
  mockGetPermissions.mockResolvedValue({status: 'granted'});
  mockGetContacts.mockResolvedValue({
    data: numbers.map((n, i) => ({id: `c${i}`, phoneNumbers: [{number: n}]})),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetSavedContactsForTests();
});

describe('permission posture', () => {
  it('returns "unknown" when permission is DENIED — never "not-saved"', async () => {
    mockGetPermissions.mockResolvedValue({status: 'denied'});
    expect(await getSavedState('+8801711111111')).toBe('unknown');
  });

  it('NEVER requests permission — a badge must not raise a system dialog', async () => {
    mockGetPermissions.mockResolvedValue({status: 'denied'});
    await getSavedState('+8801711111111');
    expect(mockRequestPermissions).not.toHaveBeenCalled();
  });

  it('returns "unknown" when the contacts read throws', async () => {
    mockGetPermissions.mockResolvedValue({status: 'granted'});
    mockGetContacts.mockRejectedValue(new Error('boom'));
    expect(await getSavedState('+8801711111111')).toBe('unknown');
  });

  it('returns "unknown" for a missing phone number', async () => {
    granted(['+8801711111111']);
    expect(await getSavedState(undefined)).toBe('unknown');
    expect(await getSavedState(null)).toBe('unknown');
    expect(await getSavedState('')).toBe('unknown');
  });
});

describe('matching', () => {
  it('matches an exact E.164 entry', async () => {
    granted(['+8801711111111']);
    expect(await getSavedState('+8801711111111')).toBe('saved');
  });

  it('reports a genuinely absent number as not-saved', async () => {
    granted(['+8801711111111']);
    expect(await getSavedState('+8801799999999')).toBe('not-saved');
  });

  it('matches a LOCAL-format address-book entry against an E.164 peer', async () => {
    // The common real case: you saved "01711111111", the peer is
    // "+8801711111111". A full-string compare misses it and the chip lies.
    granted(['01711111111']);
    expect(await getSavedState('+8801711111111')).toBe('saved');
  });

  it('matches through spaces, dashes and brackets', async () => {
    granted(['(017) 111-11111']);
    expect(await getSavedState('+8801711111111')).toBe('saved');
  });

  it('does NOT match two different subscribers that share a short suffix', async () => {
    granted(['+8801700001111']);
    expect(await getSavedState('+8801711111111')).toBe('not-saved');
  });

  it('ignores address-book rows too short to be a real number', async () => {
    granted(['911']);
    expect(await getSavedState('+8801711111111')).toBe('not-saved');
  });

  it('handles a contact with no phone numbers at all', async () => {
    mockGetPermissions.mockResolvedValue({status: 'granted'});
    mockGetContacts.mockResolvedValue({data: [{id: 'c0'}]});
    expect(await getSavedState('+8801711111111')).toBe('not-saved');
  });
});

describe('the index is built once per session', () => {
  it('reads the address book ONCE across many lookups', async () => {
    granted(['+8801711111111']);
    await getSavedState('+8801711111111');
    await getSavedState('+8801722222222');
    await getSavedState('+8801733333333');
    expect(mockGetContacts).toHaveBeenCalledTimes(1);
  });

  it('concurrent lookups share ONE read rather than racing', async () => {
    granted(['+8801711111111']);
    await Promise.all([
      getSavedState('+8801711111111'),
      getSavedState('+8801722222222'),
    ]);
    expect(mockGetContacts).toHaveBeenCalledTimes(1);
  });

  it('invalidate forces a re-read, so a save flips the chip without a restart', async () => {
    granted(['+8801711111111']);
    expect(await getSavedState('+8801799999999')).toBe('not-saved');
    granted(['+8801711111111', '+8801799999999']);
    invalidateSavedContacts();
    expect(await getSavedState('+8801799999999')).toBe('saved');
  });
});

describe('saving', () => {
  it('opens the SYSTEM form pre-filled, and does not write silently', async () => {
    // addContactAsync would write straight into the user's address book on a
    // tap. presentFormAsync shows them exactly what will be saved and lets
    // them edit or cancel — the right default for an outward-facing action.
    mockPresentForm.mockResolvedValue(undefined);
    await presentSaveContact({displayName: 'Wolf Bravo', phoneE164: '+8801711111111'});
    expect(mockPresentForm).toHaveBeenCalledTimes(1);
    const [contactId, contact] = mockPresentForm.mock.calls[0];
    expect(contactId).toBeNull();
    expect(contact.name).toBe('Wolf Bravo');
    expect(contact.phoneNumbers[0].number).toBe('+8801711111111');
  });

  it('invalidates the index after the sheet closes', async () => {
    granted(['+8801711111111']);
    await getSavedState('+8801711111111');
    expect(mockGetContacts).toHaveBeenCalledTimes(1);
    mockPresentForm.mockResolvedValue(undefined);
    await presentSaveContact({displayName: 'X', phoneE164: '+8801799999999'});
    await getSavedState('+8801711111111');
    expect(mockGetContacts).toHaveBeenCalledTimes(2);
  });
});
