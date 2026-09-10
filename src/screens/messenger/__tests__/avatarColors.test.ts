/**
 * B-286 — "the avatar in the messenger list shows one colour but in the chat it
 * shows a different colour."
 *
 * The cause was FIVE copies of the same hash against five different palettes,
 * and a chat header that used a fixed purple keyed on nothing at all. So this
 * suite has two halves, and both are load-bearing:
 *
 *   1. The behaviour — list, chat header, calls log and groups list must
 *      resolve the SAME hue for the same conversation id.
 *   2. The shape — no screen may re-introduce a local palette. A pure unit test
 *      cannot catch that, because a sixth copy would simply never be imported
 *      here and every assertion above would still pass. Hence the source scan.
 *
 * The screens mount RN views, so the node project cannot import them; the scan
 * is comment-stripped, and nothing below is `\n`-anchored because these files
 * are CRLF and a `\n` anchor matches nothing and passes VACUOUSLY.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  AVATAR_PALETTE,
  avatarColorFor,
  avatarGradientFor,
} from '../avatarColors';
import {ROLE_COLORS, colorForSender} from '../senderColors';

function strip(...rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const S = ['src', 'screens', 'messenger'];
const chat   = strip(...S, 'ChatScreen.tsx');
const home   = strip(...S, 'MessengerHomeScreen.tsx');
const calls  = strip(...S, 'CallsLogScreen.tsx');
const groups = strip(...S, 'GroupsScreen.tsx');
const info   = strip(...S, 'ChatInfoScreen.tsx');

/** Ids shaped like the real ones: uuid conversations and `direct:<peer>` slots. */
const IDS = [
  '7f3a91c2-1d4e-4b8a-9c02-6e5f0a1b2c3d',
  'direct:u-deadbeefcafe',
  'grp-ops-room-42',
  'a', '', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
];

describe('B-286 — every surface agrees on a conversation colour', () => {
  it('the chat header gradient is the same hue as the list swatch', () => {
    // THE BUG, stated directly: these two are what the founder compared.
    for (const id of IDS) {
      const solid = avatarColorFor(id);
      const grad = avatarGradientFor(id);
      const entry = AVATAR_PALETTE.find(p => p.solid === solid);
      expect(entry).toBeDefined();
      expect(grad).toEqual(entry!.gradient);
    }
  });

  it('is stable — the same id always resolves the same colour', () => {
    for (const id of IDS) {
      expect(avatarColorFor(id)).toBe(avatarColorFor(id));
      expect(avatarGradientFor(id)).toEqual(avatarGradientFor(id));
    }
  });

  it('actually varies — a single colour for everyone would also "agree"', () => {
    // Guards the degenerate fix: returning one constant everywhere would pass
    // every equality assertion above and still be the reported bug.
    const seen = new Set(IDS.map(avatarColorFor));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('spreads across the whole palette, so no entry is dead', () => {
    const ids = Array.from({length: 400}, (_, i) => `conv-${i}`);
    expect(new Set(ids.map(avatarColorFor)).size).toBe(AVATAR_PALETTE.length);
  });

  it('never throws on a corrupt row', () => {
    // A restore mid-flight can hand us a null id. The home screen render used
    // to die on exactly this class of row.
    for (const bad of [null, undefined, '']) {
      expect(() => avatarColorFor(bad)).not.toThrow();
      expect(AVATAR_PALETTE.map(p => p.solid)).toContain(avatarColorFor(bad));
      expect(avatarGradientFor(bad)).toHaveLength(2);
    }
  });

  it('every palette entry is a real hex colour', () => {
    const hex = /^#[0-9a-fA-F]{6}$/;
    for (const {solid, gradient} of AVATAR_PALETTE) {
      expect(solid).toMatch(hex);
      expect(gradient[0]).toMatch(hex);
      expect(gradient[1]).toMatch(hex);
      // A "gradient" of one repeated colour is a flat fill wearing a costume.
      expect(gradient[0]).not.toBe(gradient[1]);
    }
  });
});

describe('B-286 — the per-speaker tint stays a separate, single helper', () => {
  it('tolerates a message with no sender_id', () => {
    // ChatScreen kept its own copy of this function purely for this guard,
    // and that copy is how the palettes drifted apart.
    for (const bad of [null, undefined, '']) {
      expect(() => colorForSender(bad)).not.toThrow();
      expect(ROLE_COLORS).toContain(colorForSender(bad));
    }
  });

  it('is not the conversation palette — different job, different colours', () => {
    // Speaker tint distinguishes WHO IS TALKING inside one thread; the avatar
    // colour identifies a conversation. Merging them would make a group's
    // avatar collide with one member's name colour.
    const solids = new Set(AVATAR_PALETTE.map(p => p.solid));
    expect(ROLE_COLORS.some(c => solids.has(c))).toBe(false);
  });
});

describe('B-286 — no screen re-introduces a local palette', () => {
  const SCREENS: Array<[string, string]> = [
    ['ChatScreen', chat],
    ['MessengerHomeScreen', home],
    ['CallsLogScreen', calls],
    ['GroupsScreen', groups],
    ['ChatInfoScreen', info],
  ];

  it.each(SCREENS)('%s defines no inline colour array', (_name, src) => {
    // Threshold is FIVE, not three. Every one of the five palette copies had 6
    // or 7 entries, while a legitimate `<LinearGradient colors={...}>` on these
    // screens has 2-3 stops — the compose button's 3-stop cobalt ramp is a real
    // one and must not trip this. Five is comfortably above every gradient in
    // the tree and below every palette that has ever appeared in it.
    const inline = src.match(/\[\s*'#[0-9a-fA-F]{6}'\s*(?:,\s*'#[0-9a-fA-F]{6}'\s*){4,}\]/g);
    expect(inline).toBeNull();
  });

  it.each(SCREENS)('%s defines no local hash of its own', (_name, src) => {
    // The tell shared by all five copies: `h * 31 + charCodeAt`.
    expect(src).not.toMatch(/\*\s*31\s*\+[^;]*charCodeAt/);
  });

  it('the chat header no longer paints a fixed gradient constant', () => {
    // AVATAR_GRADIENT could not vary by conversation — that is why the header
    // and the list could never agree.
    expect(chat).not.toContain('AVATAR_GRADIENT');
    expect(chat).toContain('avatarGradientFor(conversationId)');
  });

  it.each([
    ['MessengerHomeScreen', home],
    ['CallsLogScreen', calls],
    ['GroupsScreen', groups],
    ['ChatInfoScreen', info],
  ])('%s resolves its avatar colour from the shared module', (_name, src) => {
    expect(src).toContain("from './avatarColors'");
    expect(src).toMatch(/avatarColorFor\(/);
  });

  it('the home list and the chat header key on the SAME value', () => {
    // Both must hash the conversation id. Home passes `c.id` as the route's
    // `conversationId`, so hashing either side on a peer id or a name would
    // silently re-open the bug while every unit assertion above still passed.
    expect(home).toContain('avatarColorFor(c.id)');
    expect(chat).toContain('avatarGradientFor(conversationId)');
  });
});
