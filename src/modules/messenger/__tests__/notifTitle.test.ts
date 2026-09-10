/**
 * sqa.md bug register — this suite pins: B-411.
 *
 * B-411 (notification titled `Bravo · <8hex>` for an unsaved sender) is
 * pinned by the ONE title rule: the placeholder pattern maps to directory
 * name → phone → generic and NEVER renders; a registered-directory name
 * carries the "· Unsaved" tag; address-book/custom names render plain; a
 * row with NO provenance flag renders plain (fail-safe — never mislabel a
 * saved contact as Unsaved).
 */
import {resolveNotifTitle, isPlaceholderName, UNSAVED_TAG} from '../contacts/notifTitle';

const PEER = 'c700ccde-1234-5678-9abc-def012345678';
const PLACEHOLDER = `Bravo · ${PEER.slice(0, 8)}`;

describe('resolveNotifTitle (B-411)', () => {
  it('placeholder + directory name → tagged directory name', () => {
    const r = resolveNotifTitle({name: PLACEHOLDER, name_source: 'placeholder', peerUserId: PEER, directoryName: 'Jack Bravo'});
    expect(r.title).toBe('Jack Bravo' + UNSAVED_TAG);
    expect(r.displayName).toBe('Jack Bravo');
    expect(r.isUnsaved).toBe(true);
  });

  it('placeholder + phone only → the phone, plain', () => {
    const r = resolveNotifTitle({name: PLACEHOLDER, peerUserId: PEER, phoneE164: '+8801711000000'});
    expect(r.title).toBe('+8801711000000');
    expect(r.displayName).toBe('+8801711000000');
  });

  it('placeholder + nothing known → undefined (caller generic); the hex NEVER escapes', () => {
    const r = resolveNotifTitle({name: PLACEHOLDER, peerUserId: PEER});
    expect(r.title).toBeUndefined();
    expect(r.displayName).toBeUndefined();
  });

  it('pattern beats flag: a placeholder-shaped name is mapped even when flagged contact', () => {
    const r = resolveNotifTitle({name: PLACEHOLDER, name_source: 'contact', peerUserId: PEER, phoneE164: '+123'});
    expect(r.title).toBe('+123');
  });

  it('bare-id and slice(0,8) names are placeholders too (pre-flag vault rows)', () => {
    expect(resolveNotifTitle({name: PEER, peerUserId: PEER}).title).toBeUndefined();
    expect(resolveNotifTitle({name: PEER.slice(0, 8), peerUserId: PEER}).title).toBeUndefined();
  });

  it("profile → 'Name · Unsaved'; displayName stays untagged for in-app/person use", () => {
    const r = resolveNotifTitle({name: 'John Doe', name_source: 'profile', peerUserId: PEER});
    expect(r.title).toBe('John Doe' + UNSAVED_TAG);
    expect(r.displayName).toBe('John Doe');
    expect(r.isUnsaved).toBe(true);
  });

  it('contact and custom render plain', () => {
    expect(resolveNotifTitle({name: 'Mom 🌸', name_source: 'custom'}).title).toBe('Mom 🌸');
    expect(resolveNotifTitle({name: 'John Doe', name_source: 'contact'}).title).toBe('John Doe');
    expect(resolveNotifTitle({name: 'Mom 🌸', is_custom_name: true, name_source: 'profile'}).title).toBe('Mom 🌸');
  });

  it('missing flag + real name → plain (fail-safe: never a wrong Unsaved tag)', () => {
    const r = resolveNotifTitle({name: 'Sahana Begum', peerUserId: PEER});
    expect(r.title).toBe('Sahana Begum');
    expect(r.isUnsaved).toBe(false);
  });

  it('a placeholder-shaped directory name is skipped, not rendered', () => {
    const r = resolveNotifTitle({name: PLACEHOLDER, peerUserId: PEER, directoryName: PEER.slice(0, 8), phoneE164: '+123'});
    expect(r.title).toBe('+123');
  });

  it('no name at all behaves like a placeholder row', () => {
    expect(resolveNotifTitle({peerUserId: PEER, directoryName: 'Jack'}).title).toBe('Jack' + UNSAVED_TAG);
    expect(resolveNotifTitle({}).title).toBeUndefined();
  });
});

describe('isPlaceholderName re-export parity (B-79)', () => {
  it('matches the shapes the store mints', () => {
    expect(isPlaceholderName('Bravo · 3165d0e1')).toBe(true);
    expect(isPlaceholderName(PEER.slice(0, 8), PEER)).toBe(true);
    expect(isPlaceholderName('Jack Bravo', PEER)).toBe(false);
  });
});
