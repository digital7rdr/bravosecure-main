/**
 * B-291 — group photo.
 *
 * Founder approved this explicitly after I flagged it as arch-gated, so it is
 * built the most conservative way available: the picture is an ordinary
 * encrypted attachment (AES-256-CBC, unique per-file key, same MediaClient path
 * every chat photo takes) and group state carries only the REFERENCE. No new
 * crypto primitive, no new storage, no change to the sealed-sender envelope.
 *
 * What IS new is one `GroupAdminAction` member. That is why the tests below lean
 * hardest on the two properties a new signed action can get wrong:
 *
 *   1. The canonical bytes must cover every field a receiver DECRYPTS with.
 *      Signing only the objectKey would let a replayed envelope swap the key.
 *   2. Old clients must not break. `applyAdminAction`'s `default:` branch was
 *      written to no-op on unknown actions for exactly this rollout shape.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {applyAdminAction, makeNewGroup} from '@bravo/messenger-core';
import type {GroupPhotoRef, GroupState} from '@bravo/messenger-core';

function strip(...rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const PHOTO: GroupPhotoRef = {
  objectKey: 'grp/7f3a91c2/photo-1',
  keyB64:    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ivB64:     'BBBBBBBBBBBBBBBBBBBBBA==',
  mimeType:  'image/jpeg',
  size:      20_480,
  updatedAt: 1_785_000_000_000,
};

const OWNER = 'u-owner';
const MEMBER = 'u-member';

function freshGroup(): GroupState {
  return makeNewGroup({
    name:           'Ops Room',
    owner:          OWNER,
    ownerDeviceId:  1,
    members:        [{userId: MEMBER, deviceId: 1}],
  });
}

describe('B-291 — applying a photo action', () => {
  it('an admin can set the photo', () => {
    const g = freshGroup();
    const next = applyAdminAction(g, {type: 'photo', photo: PHOTO, atEpoch: g.epoch}, OWNER);
    expect(next.photo).toEqual(PHOTO);
    expect(next.epoch).toBe(g.epoch + 1);
  });

  it('an admin can clear the photo', () => {
    const g = freshGroup();
    const set = applyAdminAction(g, {type: 'photo', photo: PHOTO, atEpoch: g.epoch}, OWNER);
    const cleared = applyAdminAction(set, {type: 'photo', photo: null, atEpoch: set.epoch}, OWNER);
    expect(cleared.photo).toBeNull();
    expect(cleared.epoch).toBe(set.epoch + 1);
  });

  it('does NOT rotate the master key', () => {
    // Membership is unchanged, so the key still binds exactly the same devices.
    // Rotating it for a picture would risk a partial rekey for no security gain.
    const g = freshGroup();
    const next = applyAdminAction(g, {type: 'photo', photo: PHOTO, atEpoch: g.epoch}, OWNER);
    expect(next.masterKeyB64).toBe(g.masterKeyB64);
    expect(next.members).toEqual(g.members);
  });

  it('a NON-admin cannot set the photo', () => {
    // Same silent-drop gate every other admin action uses — a non-admin
    // mutating group state must not even learn that it failed.
    const g = freshGroup();
    const next = applyAdminAction(g, {type: 'photo', photo: PHOTO, atEpoch: g.epoch}, MEMBER);
    expect(next).toBe(g);
    expect(next.photo).toBeUndefined();
  });

  it('a stale-epoch action is dropped', () => {
    // Replay protection. Two admins racing at one epoch: the loser's action
    // must not land at the wrong epoch.
    const g = freshGroup();
    const next = applyAdminAction(g, {type: 'photo', photo: PHOTO, atEpoch: g.epoch + 5}, OWNER);
    expect(next).toBe(g);
  });

  it('extends the transcript hash like every other state change', () => {
    // Audit P1-G1 — the transcript chains EVERY applied action. An action that
    // mutated state without extending it would let two devices with different
    // histories agree on a hash.
    const g = freshGroup();
    const next = applyAdminAction(g, {type: 'photo', photo: PHOTO, atEpoch: g.epoch}, OWNER);
    expect(next.transcriptHash).toBeDefined();
    expect(next.transcriptHash).not.toBe(g.transcriptHash);
  });

  it('setting and CLEARING produce different transcripts', () => {
    // If the canonical bytes ignored the photo payload, set-then-clear and
    // clear-then-set would be indistinguishable in the transcript.
    const g = freshGroup();
    const set = applyAdminAction(g, {type: 'photo', photo: PHOTO, atEpoch: g.epoch}, OWNER);
    const clr = applyAdminAction(g, {type: 'photo', photo: null,  atEpoch: g.epoch}, OWNER);
    expect(set.transcriptHash).not.toBe(clr.transcriptHash);
  });

  it('two DIFFERENT photos produce different transcripts', () => {
    const g = freshGroup();
    const a = applyAdminAction(g, {type: 'photo', photo: PHOTO, atEpoch: g.epoch}, OWNER);
    const b = applyAdminAction(
      g,
      {type: 'photo', photo: {...PHOTO, objectKey: 'grp/other/photo-9'}, atEpoch: g.epoch},
      OWNER,
    );
    expect(a.transcriptHash).not.toBe(b.transcriptHash);
  });

  it('a swapped decryption KEY produces a different transcript', () => {
    // THE ONE THAT MATTERS. If the canonical bytes covered only the objectKey,
    // an attacker replaying a captured envelope could substitute a different
    // key/IV for the same object and the signature would still verify.
    const g = freshGroup();
    const a = applyAdminAction(g, {type: 'photo', photo: PHOTO, atEpoch: g.epoch}, OWNER);
    const swappedKey = applyAdminAction(
      g,
      {type: 'photo', photo: {...PHOTO, keyB64: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC='}, atEpoch: g.epoch},
      OWNER,
    );
    const swappedIv = applyAdminAction(
      g,
      {type: 'photo', photo: {...PHOTO, ivB64: 'CCCCCCCCCCCCCCCCCCCCCA=='}, atEpoch: g.epoch},
      OWNER,
    );
    expect(a.transcriptHash).not.toBe(swappedKey.transcriptHash);
    expect(a.transcriptHash).not.toBe(swappedIv.transcriptHash);
  });

  it('leaves a group with no photo field untouched — old state decodes fine', () => {
    // `photo` is additive and optional: every group state and backup mirror
    // written before this feature must load unchanged.
    const g = freshGroup();
    expect(g.photo).toBeUndefined();
    const renamed = applyAdminAction(g, {type: 'rename', name: 'Ops', atEpoch: g.epoch}, OWNER);
    expect(renamed.photo).toBeUndefined();
    expect(renamed.name).toBe('Ops');
  });
});

describe('B-291 — the photo is an ordinary encrypted attachment', () => {
  const core = strip('packages', 'messenger-core', 'src', 'groups', 'groupClient.ts');
  const runtimeSrc = strip('src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

  it('the signed bytes cover objectKey, key, iv and mime', () => {
    const line = /case 'photo':[\s\S]{0,400}?photo\|/.exec(core);
    expect(line).not.toBeNull();
    const span = core.slice(core.indexOf("case 'photo':"), core.indexOf("case 'photo':") + 500);
    for (const field of ['objectKey', 'keyB64', 'ivB64', 'mimeType']) {
      expect(span).toContain(field);
    }
  });

  it('a cleared photo signs distinct bytes rather than an empty string', () => {
    const span = core.slice(core.indexOf("case 'photo':"), core.indexOf("case 'photo':") + 500);
    expect(span).toContain('none');
  });

  it('uploads through the SAME MediaClient path a chat photo takes', () => {
    // No new crypto: `uploadEncrypted` is AES-256-CBC with a fresh per-file key.
    const at = runtimeSrc.indexOf('setGroupPhoto:');
    expect(at).toBeGreaterThan(-1);
    const body = runtimeSrc.slice(at, at + 3000);
    expect(body).toContain('getUploadMediaClient().uploadEncrypted');
    expect(body).toContain('readUriBytes');
  });

  it('uploads BEFORE broadcasting the reference', () => {
    // Broadcasting first would point every member at an object that may never
    // exist, and a permanently broken picture cannot be retried by the user.
    const at = runtimeSrc.indexOf('setGroupPhoto:');
    const body = runtimeSrc.slice(at, at + 3000);
    const upload = body.indexOf('uploadEncrypted');
    const broadcast = body.indexOf('broadcastToGroup');
    expect(upload).toBeGreaterThan(-1);
    expect(broadcast).toBeGreaterThan(upload);
  });

  it('B-292 THE BUG: grants every member download access', () => {
    // Holding the decryption key is NOT sufficient. The media service enforces a
    // per-object grant list, so an ungranted member 403s at the download and
    // shows the initials disc forever. v1.0.172 shipped without this: the admin
    // saw the photo (the uploader is implicitly allowed) and nobody else did.
    // Every chat-attachment path already calls registerGrants for this reason.
    const at = runtimeSrc.indexOf('setGroupPhoto:');
    const body = runtimeSrc.slice(at, at + 3000);
    expect(body).toMatch(/registerGrants\([^)]*Object\.keys\(cur\.members\)/);
  });

  it('B-292 grants BEFORE broadcasting the reference', () => {
    // Granting after the fan-out leaves a window where a fast member applies the
    // action, fetches, 403s, and caches nothing — the retry only comes on a
    // later remount, so the picture looks permanently missing.
    const at = runtimeSrc.indexOf('setGroupPhoto:');
    const body = runtimeSrc.slice(at, at + 3000);
    const grant = body.indexOf('registerGrants');
    const broadcast = body.indexOf('broadcastToGroup');
    expect(grant).toBeGreaterThan(-1);
    expect(broadcast).toBeGreaterThan(grant);
  });

  it('B-292 fails LOUD when the grant fails', () => {
    // Shipping a reference nobody can read is worse than refusing the change:
    // the admin would believe it worked and no member would ever see it.
    const at = runtimeSrc.indexOf('setGroupPhoto:');
    const body = runtimeSrc.slice(at, at + 3000);
    expect(body).toMatch(/throw new Error\(`group photo access grant failed/);
  });

  it('B-292 grants a LATER-added member the existing photo', () => {
    // Same defect one step removed: someone added after the photo was set has no
    // grant, so they alone would see the fallback disc.
    const at = runtimeSrc.indexOf('addGroupMember:');
    expect(at).toBeGreaterThan(-1);
    const body = runtimeSrc.slice(at, at + 6000);
    expect(body).toMatch(/photo\?\.objectKey/);
    expect(body).toMatch(/registerGrants\([^)]*newMember\.userId/);
  });

  it('B-292 a failed grant on ADD does not abort the add', () => {
    // The add has already been broadcast by that point, and the photo is
    // cosmetic — throwing here would desync membership over a picture.
    const at = runtimeSrc.indexOf('addGroupMember:');
    const body = runtimeSrc.slice(at, at + 6000);
    const g = body.indexOf('registerGrants');
    const span = body.slice(g - 200, g + 400);
    expect(span).toContain('catch');
    expect(span).not.toMatch(/catch[\s\S]{0,80}throw/);
  });

  it('gates on admin and serialises under the per-group lock', () => {
    const at = runtimeSrc.indexOf('setGroupPhoto:');
    const body = runtimeSrc.slice(at, at + 3000);
    expect(body).toContain('runWithGroupAdminLock');
    expect(body).toMatch(/admin/);
    expect(body).toContain('only admins can change the group photo');
  });

  it('never rekeys', () => {
    const at = runtimeSrc.indexOf('setGroupPhoto:');
    const body = runtimeSrc.slice(at, runtimeSrc.indexOf('removeGroupMember:', at));
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toContain('newMasterKeyB64');
    expect(body).not.toMatch(/type:\s*'rekey'/);
  });

  it('does not log the photo key', () => {
    // The per-file key is key material. `logAudit.test.ts` enforces this
    // repo-wide; this is the local, specific assertion.
    const at = runtimeSrc.indexOf('setGroupPhoto:');
    const body = runtimeSrc.slice(at, at + 3000);
    const logs = body.match(/console\.(warn|log|error)\([^)]*\)/g) ?? [];
    for (const line of logs) {
      expect(line).not.toContain('keyB64');
      expect(line).not.toContain('photo.key');
    }
  });
});

describe('B-291 — every surface that draws a group shows the photo', () => {
  const chat = strip('src', 'screens', 'messenger', 'ChatScreen.tsx');
  const home = strip('src', 'screens', 'messenger', 'MessengerHomeScreen.tsx');
  const info = strip('src', 'screens', 'messenger', 'ChatInfoScreen.tsx');
  const admin = strip('src', 'modules', 'messenger', 'runtime', 'applyGroupAdmin.ts');

  it.each([
    ['ChatScreen header', chat],
    ['MessengerHome list', home],
    ['ChatInfo sheet', info],
  ])('%s resolves through GroupAvatar', (_name, src) => {
    // A photo visible on only one screen reads as "it did not save" — the exact
    // shape of B-286, where six surfaces disagreed about one value.
    expect(src).toContain('GroupAvatar');
    expect(src).toContain("from '@/modules/messenger/ui/GroupAvatar'");
  });

  it('the receive path leaves a system line', () => {
    // Otherwise a picture changing under a member is indistinguishable from a
    // rendering glitch.
    expect(admin).toMatch(/action\.type === 'photo' && next !== args\.existing/);
    expect(admin).toContain('appendGroupPhotoChangedEvent');
  });

  it('only an admin gets the edit affordance', () => {
    // A tappable avatar that always fails reads as broken.
    expect(info).toMatch(/canEditPhoto = isGroup && isAdmin && !!runtime\?\.setGroupPhoto/);
  });

  it('downscales before upload', () => {
    // A group avatar renders at 84pt at most. Shipping a full-resolution phone
    // photo would make every member download megabytes to draw a small circle.
    expect(info).toMatch(/maxWidth:\s*512/);
    expect(info).toMatch(/maxHeight:\s*512/);
  });

  it('offers removal only when there IS a photo', () => {
    expect(info).toContain('Remove photo');
    expect(info).toMatch(/if \(hasPhoto\)/);
  });
});
