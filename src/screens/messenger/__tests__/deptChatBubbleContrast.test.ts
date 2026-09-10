/**
 * Departmental chat — per-sender colour.
 *
 * The colour tints the sender's NAME and the left rule, the way a normal
 * messenger thread does. A short-lived variant painted the WHOLE bubble in it
 * (and needed WCAG contrast helpers, a scrim and a dark plate for every nested
 * card to stay legible); that was reverted on request. These tests pin what the
 * screen does NOW, and the absence assertions stop the paint creeping back in
 * without the contrast machinery that made it readable.
 *
 * colorForSender is pure and lives outside the screen, so it is unit-tested for
 * real; the JSX has to be a source scan because DepartmentChatScreen imports
 * expo-clipboard / rn-emoji-keyboard, which the Jest transform cannot parse.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {ROLE_COLORS, colorForSender} from '../senderColors';

describe('colorForSender is stable per person', () => {
  it('the same id always gets the same colour', () => {
    // A colour that changed between renders would make the whole scheme
    // useless for telling people apart at a glance.
    const id = '9f1c2b7e-0000-4a1b-8c3d-aabbccddeeff';
    expect(colorForSender(id)).toBe(colorForSender(id));
  });

  it('it only ever returns colours from the palette', () => {
    for (const id of ['a', 'bb', 'user-1', 'user-2', '', '9f1c2b7e-0000-4a1b-8c3d-aabbccddeeff']) {
      expect(ROLE_COLORS).toContain(colorForSender(id));
    }
  });

  it('different people generally get different colours', () => {
    // Not a hash-quality test — just proof it is not a constant, which would
    // defeat the point of assigning colours at all.
    const ids = Array.from({length: 24}, (_, i) => `user-${i}-abcdef`);
    expect(new Set(ids.map(colorForSender)).size).toBeGreaterThan(1);
  });

  it('the palette has no duplicates', () => {
    expect(new Set(ROLE_COLORS).size).toBe(ROLE_COLORS.length);
  });
});

describe('the sender colour tints the NAME, not the whole bubble', () => {
  const code = readFileSync(
    join(process.cwd(), 'src', 'screens', 'messenger', 'DepartmentChatScreen.tsx'),
    'utf8',
  )
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(l => {
      const t = l.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');

  it('the sender name carries the colour', () => {
    expect(code).toMatch(/styles\.senderName, \{color: accent\}/);
  });

  it('the bubble background is NOT painted with it', () => {
    // Reverted on request — a normal messenger look, not a coloured bubble.
    expect(code).not.toMatch(/backgroundColor: accent/);
  });

  it('no orphaned contrast machinery is left behind', () => {
    // If the paint ever returns it must bring these back WITH it; a
    // half-reverted state where the bubble is coloured but the nested
    // foregrounds still assume the dark surface is the unreadable case.
    for (const ghost of ['onAccent', 'scrimOn', 'NESTED_CARD_PLATE', 'nestedPlate', 'painted']) {
      expect(code).not.toContain(ghost);
    }
  });

  it('senderColors exports only what is still used', () => {
    const mod = readFileSync(
      join(process.cwd(), 'src', 'screens', 'messenger', 'senderColors.ts'),
      'utf8',
    );
    expect(mod).toMatch(/export function colorForSender/);
    expect(mod).not.toMatch(/export function textOnColor/);
    expect(mod).not.toMatch(/export function scrimOn/);
  });
});
