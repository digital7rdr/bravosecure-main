/**
 * B-286 — one avatar colour per conversation, everywhere.
 *
 * Founder: "group or user avatar in messenger list shows one colour but in the
 * chat it shows a different colour."
 *
 * There were FIVE independent implementations of "pick an avatar colour", each
 * with its own palette, and between them three different hash keys:
 *
 *   MessengerHomeScreen.avatarBg   6 colours   keyed on conversation id
 *   ChatScreen.AVATAR_GRADIENT     fixed purple — keyed on NOTHING
 *   CallsLogScreen.avatarBg        6 colours   keyed on conversation id
 *   GroupsScreen.avatarBgFor       6 colours   keyed on conversation id
 *   ChatScreen.senderColorFor      7 colours   keyed on user id
 *
 * Every one of them used the identical `h * 31 + charCode` hash, so they were
 * copies that had drifted, not deliberate variants. The list and the chat header
 * could never agree: the header could not vary at all.
 *
 * This module is the only place a conversation avatar colour is chosen. The
 * palette is the one the conversation LIST already shipped, so the surface the
 * founder called correct is the one that stays put and the other three move to
 * meet it.
 *
 * Per-SPEAKER tint inside a group thread is a different job — distinguishing
 * who is talking, not identifying a conversation — and lives in
 * `senderColors.ts`. Keep them separate; do not merge the two palettes.
 */

/**
 * Paired so the flat row avatars and the gradient disc in the chat header are
 * the same HUE without being the same shade. `solid` is what a flat avatar
 * paints; `gradient` brackets it light-to-dark for a disc. Derived by hand
 * rather than computed so the values are reviewable and cannot drift when
 * someone changes a colour-maths helper.
 */
export const AVATAR_PALETTE: ReadonlyArray<{
  solid: string;
  gradient: readonly [string, string];
}> = [
  {solid: '#7B5EA7', gradient: ['#9A7BE6', '#5B43C9']},
  {solid: '#0E7490', gradient: ['#22A5C0', '#0B5C73']},
  {solid: '#065F46', gradient: ['#10A377', '#044633']},
  {solid: '#2F5BE0', gradient: ['#5B84F5', '#2445B0']},
  {solid: '#5B8DEF', gradient: ['#7FA8FF', '#3F6ED0']},
  {solid: '#3D5A8A', gradient: ['#5B7FB8', '#2C4269']},
];

/**
 * The one hash. Every screen already used this exact function; it is lifted
 * here so a future tweak cannot land on three surfaces and miss the fourth.
 *
 * `>>> 0` after each step keeps it inside uint32 so the result is identical on
 * every engine — a person must keep their colour across devices, and Hermes and
 * JSC would otherwise diverge once the accumulator passed 2^53.
 */
function hashKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {h = (h * 31 + key.charCodeAt(i)) >>> 0;}
  return h;
}

/**
 * Index into the palette for a conversation.
 *
 * A null/empty key hashes to 0 rather than throwing: a corrupt row mid-restore
 * used to crash the whole home render, and a wrong-but-painted avatar beats a
 * blank screen.
 */
function paletteIndex(key: string | null | undefined): number {
  return hashKey(key ?? '') % AVATAR_PALETTE.length;
}

/** Flat avatar colour for a conversation. Pass the CONVERSATION id. */
export function avatarColorFor(key: string | null | undefined): string {
  return AVATAR_PALETTE[paletteIndex(key)].solid;
}

/**
 * Two-stop gradient for a conversation, for surfaces that paint a disc rather
 * than a flat circle (the chat header). Same hue as `avatarColorFor` for the
 * same key — that equality is the whole point of this module and is pinned by
 * `avatarColors.test.ts`.
 */
export function avatarGradientFor(
  key: string | null | undefined,
): readonly [string, string] {
  return AVATAR_PALETTE[paletteIndex(key)].gradient;
}
