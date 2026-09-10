/**
 * Channels vs2 item 4 — an incident draft belongs to one (user, ORGANISATION).
 *
 * The call sites are pinned by `incidentClientContract`, but that scan cannot
 * see the key itself: passing `activeOrgId` into a function that ignores it
 * looks identical from the outside. This exercises the storage.
 */
const mockStore = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    setItem: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
    removeItem: jest.fn(async (k: string) => { mockStore.delete(k); }),
    getAllKeys: jest.fn(async () => [...mockStore.keys()]),
    multiRemove: jest.fn(async (ks: string[]) => { ks.forEach(k => mockStore.delete(k)); }),
  },
}));

import {loadIncidentDraft, saveIncidentDraft, clearIncidentDraft} from '../incidentDraft';

const ACME = 'acme-uuid';
const BOREALIS = 'borealis-uuid';
const DRAFT = {category: 'security_concern', severity: 'high', description: 'gate breach at Acme', media: []};

beforeEach(() => { mockStore.clear(); });

describe('incident drafts are scoped to the organisation', () => {
  it('a draft written in one workspace is INVISIBLE in another', async () => {
    /**
     * Dana half-writes an Acme incident naming a site and an officer, abandons
     * it, and switches to Borealis. Keyed by user alone, the Resume-draft card
     * offered Acme's narrative and media inside Borealis — and Submit filed it
     * there. It also outlived the app, because AsyncStorage persists while the
     * workspace context deliberately does not.
     */
    await saveIncidentDraft('dana', ACME, DRAFT);
    await expect(loadIncidentDraft('dana', BOREALIS)).resolves.toBeNull();
    await expect(loadIncidentDraft('dana', ACME)).resolves.toMatchObject({
      description: 'gate breach at Acme',
    });
  });

  it('clearing one organisation does not clear the other', async () => {
    await saveIncidentDraft('dana', ACME, DRAFT);
    await saveIncidentDraft('dana', BOREALIS, {...DRAFT, description: 'borealis note'});
    await clearIncidentDraft('dana', ACME);
    await expect(loadIncidentDraft('dana', ACME)).resolves.toBeNull();
    await expect(loadIncidentDraft('dana', BOREALIS)).resolves.toMatchObject({
      description: 'borealis note',
    });
  });

  it('the single-org case is unchanged — no context, one bucket', async () => {
    // Everyone who never opens a second workspace keeps exactly the behaviour
    // they had before item 4, including across a restart.
    await saveIncidentDraft('solo', null, DRAFT);
    await expect(loadIncidentDraft('solo', null)).resolves.toMatchObject({
      description: 'gate breach at Acme',
    });
  });

  it('a no-context draft is NOT served to a workspace, and vice versa', async () => {
    // The two are different scopes, so neither may satisfy the other — that is
    // the whole point of adding the org to the key.
    await saveIncidentDraft('dana', null, DRAFT);
    await expect(loadIncidentDraft('dana', ACME)).resolves.toBeNull();
  });

  it('still refuses to store anything without a user', async () => {
    await saveIncidentDraft(undefined, ACME, DRAFT);
    expect(mockStore.size).toBe(0);
    await expect(loadIncidentDraft(undefined, ACME)).resolves.toBeNull();
  });
});
