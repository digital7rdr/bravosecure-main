/**
 * B-289 — "group name should be changeable."
 *
 * The `rename` admin action had existed in the protocol since the group client
 * was written — a signed payload (`rename|<epoch>|<name>`), an
 * `applyAdminAction` case, a deterministic system-event id and a
 * "<actor> renamed the channel to X" renderer — and NOTHING ever built one. So
 * the name a group was created with was permanent. The fix is the missing
 * emitter, not new protocol, and that distinction is what the source scan below
 * pins: if someone "simplifies" this by inventing a different envelope, the
 * scan is what catches it.
 *
 * `productionRuntime.ts` CANNOT be imported by this project (it pulls the whole
 * native runtime), and CLAUDE.md is explicit that a green suite is therefore not
 * evidence a change there is safe. Hence: the pure rules are unit-tested, and
 * the runtime wiring is a comment-stripped source scan. That file is CRLF, so
 * nothing here is `\n`-anchored — a `\n` anchor matches nothing and passes
 * VACUOUSLY.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  GROUP_NAME_MAX,
  isGroupNameChange,
  normalizeGroupName,
} from '../runtime/groupNameRules';

function strip(...rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const runtimeSrc = strip('src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');
const infoSrc    = strip('src', 'screens', 'messenger', 'ChatInfoScreen.tsx');

describe('B-289 — cleaning a typed group name', () => {
  it('keeps an ordinary name verbatim', () => {
    expect(normalizeGroupName('Ops Room')).toBe('Ops Room');
  });

  it('trims, because a trailing space is invisible', () => {
    // Otherwise two names that LOOK identical compare unequal and the app
    // re-signs and re-broadcasts a rename that changes nothing.
    expect(normalizeGroupName('  Ops Room  ')).toBe('Ops Room');
  });

  it('collapses a pasted newline into one space', () => {
    expect(normalizeGroupName('Ops\nRoom')).toBe('Ops Room');
    expect(normalizeGroupName('Ops\r\n\tRoom')).toBe('Ops Room');
    expect(normalizeGroupName('Ops     Room')).toBe('Ops Room');
  });

  it('rejects an empty or whitespace-only name', () => {
    for (const bad of ['', '   ', '\n\t', null, undefined]) {
      expect(normalizeGroupName(bad as string)).toBeNull();
    }
  });

  it('rejects a non-string', () => {
    // The value arrives from a TextInput, but also from a signed payload a
    // remote admin controls.
    for (const bad of [42, {}, [], true]) {
      expect(normalizeGroupName(bad as unknown as string)).toBeNull();
    }
  });

  it('STRIPS bidirectional overrides — this one is a spoofing guard', () => {
    // An RTL override inside a name reorders the UI text AROUND it, so an admin
    // could make every member's group header read as something else. It must be
    // removed, not merely trimmed.
    const rlo = String.fromCodePoint(0x202e);
    const lri = String.fromCodePoint(0x2066);
    const rlm = String.fromCodePoint(0x200f);
    for (const mark of [rlo, lri, rlm]) {
      const out = normalizeGroupName(`Ops${mark}Room`);
      expect(out).not.toContain(mark);
      expect(out).toBe('Ops Room');
    }
  });

  it('replaces a stripped mark with a SPACE, not nothing', () => {
    // Deleting it would let "A<RLO>B" collapse to the single token "AB", which
    // is a different name than the user sees.
    const rlo = String.fromCodePoint(0x202e);
    expect(normalizeGroupName(`A${rlo}B`)).toBe('A B');
  });

  it('strips C0 and C1 control characters', () => {
    expect(normalizeGroupName(`Ops${String.fromCodePoint(0x00)}Room`)).toBe('Ops Room');
    expect(normalizeGroupName(`Ops${String.fromCodePoint(0x9f)}Room`)).toBe('Ops Room');
    expect(normalizeGroupName(`Ops${String.fromCodePoint(0x7f)}Room`)).toBe('Ops Room');
  });

  it('truncates instead of rejecting a long paste', () => {
    const long = 'x'.repeat(GROUP_NAME_MAX + 50);
    const out = normalizeGroupName(long)!;
    expect(Array.from(out)).toHaveLength(GROUP_NAME_MAX);
  });

  it('keeps a name of exactly the maximum length', () => {
    const exact = 'y'.repeat(GROUP_NAME_MAX);
    expect(normalizeGroupName(exact)).toBe(exact);
  });

  it('never splits an emoji when truncating', () => {
    // Slicing by code UNIT would leave a lone surrogate that renders as a
    // replacement glyph on every member's device.
    const out = normalizeGroupName('🛡️'.repeat(GROUP_NAME_MAX + 10))!;
    // Iterating by CODE POINT is the test: a well-formed string never yields a
    // code point in the surrogate range, because both halves are consumed
    // together. A truncation that cut mid-pair leaves a lone half, which shows
    // up here immediately. (Checking `split('')` would be wrong — that splits
    // by code UNIT, so a perfectly valid emoji also looks like two surrogates.)
    for (const ch of out) {
      const cp = ch.codePointAt(0)!;
      expect(cp >= 0xd800 && cp <= 0xdfff).toBe(false);
    }
    // And it survives the signed payload's own encoder unchanged.
    expect(new TextDecoder().decode(new TextEncoder().encode(out))).toBe(out);
  });

  it('preserves non-Latin names', () => {
    // The app ships in regions well outside ASCII; a filter that mangled these
    // would be worse than no filter.
    for (const name of ['প্রহরী দল', 'Отряд', '警備班', 'فريق الأمن']) {
      expect(normalizeGroupName(name)).toBe(name);
    }
  });
});

describe('B-289 — is a rename worth broadcasting', () => {
  it('no, when nothing actually changed', () => {
    expect(isGroupNameChange('Ops Room', 'Ops Room')).toBe(false);
    // Same name once cleaned — signing this would be pure noise.
    expect(isGroupNameChange('Ops Room', '  Ops   Room ')).toBe(false);
  });

  it('yes, when the name differs', () => {
    expect(isGroupNameChange('Ops Room', 'Ops Room 2')).toBe(true);
    expect(isGroupNameChange(null, 'Ops Room')).toBe(true);
  });

  it('no, when the new name is unusable', () => {
    expect(isGroupNameChange('Ops Room', '   ')).toBe(false);
    expect(isGroupNameChange('Ops Room', null)).toBe(false);
  });
});

describe('B-289 — the runtime emitter is wired to the EXISTING action', () => {
  it('exists at all — this is the whole bug', () => {
    expect(runtimeSrc).toContain('renameGroup:');
  });

  it("builds the protocol's own rename action", () => {
    // Not a new envelope shape: the receiver's applyAdminAction case and the
    // signed `rename|<epoch>|<name>` payload already existed.
    expect(runtimeSrc).toMatch(/type:\s*'rename'\s*as\s*const/);
    expect(runtimeSrc).toMatch(/renameGroup:[\s\S]{0,2000}?atEpoch:\s*cur\.epoch/);
  });

  it('gates on admin, like every other admin action', () => {
    const at = runtimeSrc.indexOf('renameGroup:');
    const body = runtimeSrc.slice(at, at + 2500);
    expect(body).toMatch(/meAsMember\?\.admin/);
    expect(body).toMatch(/only admins can rename/);
  });

  it('serialises under the per-group admin lock', () => {
    // Audit P1-G2. Two concurrent renames at one epoch would otherwise both
    // sign against the same base epoch and one would be silently dropped.
    const at = runtimeSrc.indexOf('renameGroup:');
    expect(runtimeSrc.slice(at, at + 400)).toContain('runWithGroupAdminLock');
  });

  it('validates through the SAME helper the screen uses', () => {
    // If the screen and the runtime cleaned differently, the name the user
    // approved would not be the name that got signed.
    const at = runtimeSrc.indexOf('renameGroup:');
    expect(runtimeSrc.slice(at, at + 1200)).toContain('normalizeGroupName');
    expect(infoSrc).toContain('normalizeGroupName');
  });

  it('does NOT rekey — membership is unchanged', () => {
    // A rename must not force a key redistribution that can partially fail.
    // The rekey planners are what a copy-paste from removeGroupMember would
    // have dragged in.
    const at = runtimeSrc.indexOf('renameGroup:');
    const body = runtimeSrc.slice(at, runtimeSrc.indexOf('removeGroupMember:', at));
    expect(body.length).toBeGreaterThan(200);   // the slice really spans the fn
    expect(body).not.toContain('planRemoveAndRekey');
    expect(body).not.toContain('newMasterKeyB64');
    expect(body).not.toMatch(/type:\s*'rekey'/);
  });

  it('applies via applyAdminAction, the same reducer receivers run', () => {
    // Hand-editing `{...cur, name}` locally would let our state diverge in
    // shape from every peer's, and would skip the epoch bump.
    const at = runtimeSrc.indexOf('renameGroup:');
    expect(runtimeSrc.slice(at, at + 2500)).toContain('applyAdminAction(cur, action');
  });

  it('reflects the rename in the UI through the shared helper', () => {
    // B-290 MOVED these three behaviours — the system line, `is_custom_name`
    // and the row-preserving upsert — out of this emitter and into
    // `applyGroupRename.ts`, because the RECEIVE path needs all three too and a
    // second copy is how B-286 happened. The behaviours are still pinned: see
    // "B-290 — the rename must reach what the user SEES" below, which asserts
    // them at their new home AND asserts this emitter no longer does them
    // itself. Anchors go stale; the properties do not.
    const at = runtimeSrc.indexOf('renameGroup:');
    expect(runtimeSrc.slice(at, at + 2500)).toContain('applyGroupRenameToUi');
  });
});

describe('B-290 — the rename must reach what the user SEES', () => {
  // Founder, on the B-289 build: "i change the name but the changed name does
  // not show to me. admin change the name, i am in these group, for me the name
  // is not showing." The rename applied to `groups[id].name` — crypto state —
  // and NOTHING reads that for display.
  const adminSrc = strip('src', 'modules', 'messenger', 'runtime', 'applyGroupAdmin.ts');

  it('THE BUG: the receive path has a rename branch at all', () => {
    // `add` and `remove` both reconciled what the user sees. `rename` had no
    // branch, so a member's device recorded the new name and showed the old one
    // forever. This assertion is the whole regression.
    expect(adminSrc).toMatch(/action\.type === 'rename' && next !== args\.existing/);
  });

  it('the receive path updates the conversation, not just group state', () => {
    const at = adminSrc.indexOf("action.type === 'rename'");
    expect(at).toBeGreaterThan(-1);
    expect(adminSrc.slice(at, at + 500)).toContain('applyGroupRenameToUi');
  });

  it('attributes the rename to the SENDER, not to self', () => {
    // `args.peer.userId` is taken from the verified sender cert. Using
    // deps.ownUserId here would make every member's thread read "You renamed…".
    const at = adminSrc.indexOf("action.type === 'rename'");
    const body = adminSrc.slice(at, at + 500);
    expect(body).toContain('actorUserId:  args.peer.userId');
    expect(body).toContain('newName:      next.name');
  });

  it('BOTH sides go through ONE helper — no second copy', () => {
    // Two copies of "apply a rename" is exactly the shape that produced B-286's
    // six drifted avatar-colour functions. Neither side may write the row or
    // append the system line itself.
    for (const src of [adminSrc, runtimeSrc]) {
      expect(src).toContain('applyGroupRenameToUi');
    }
    const at = runtimeSrc.indexOf('renameGroup:');
    const emitter = runtimeSrc.slice(at, runtimeSrc.indexOf('removeGroupMember:', at));
    expect(emitter).not.toContain('upsertConversation');
    expect(emitter).not.toContain('appendChannelRenamedEvent');
  });

  it('the helper reads LIVE store state, not a passed-in snapshot', () => {
    // The emitter awaits a cert fetch and a whole fan-out before it applies, so
    // a snapshot captured at the top of renameGroup is stale by then — which is
    // how the admin's own device could miss its own rename.
    const helper = strip('src', 'modules', 'messenger', 'runtime', 'applyGroupRename.ts');
    expect(helper).toContain('useMessengerStore.getState()');
    // It must not accept a store/snapshot parameter — that is the trap.
    expect(helper).not.toMatch(/store:\s*\{/);
  });

  it('the helper spreads the existing row rather than replacing it', () => {
    const helper = strip('src', 'modules', 'messenger', 'runtime', 'applyGroupRename.ts');
    expect(helper).toMatch(/upsertConversation\(\{\s*\.\.\.row/);
    expect(helper).toContain('is_custom_name: true');
  });
});

describe('B-289 — the screen only offers it to admins', () => {
  it('gates the editable name on admin AND runtime support', () => {
    // A tappable label that does nothing reads as broken; the runtime rejects a
    // non-admin rename anyway, so the UI must not invite the attempt.
    expect(infoSrc).toMatch(/isGroup && isAdmin && !!runtime\?\.renameGroup/);
  });

  it('caps the input at the shared maximum', () => {
    expect(infoSrc).toContain('maxLength={GROUP_NAME_MAX}');
  });

  it('mounts the rename sheet only while open', () => {
    // Same rule as the chat sheets: `<Modal visible={false}>` still constructs
    // its whole child tree on every render.
    expect(infoSrc).toContain('{groupNameOpen && (');
  });
});
