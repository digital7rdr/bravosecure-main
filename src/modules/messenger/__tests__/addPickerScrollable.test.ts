/**
 * B-308 — the 1:1 "Add to call" picker list was not scrollable.
 *
 * Founder (2026-07-27, on-device): "when the list comes its not slidable."
 *
 * CallScreen's add picker rendered `addPickerCandidates.map(...)` inside a
 * plain `<View style={styles.addPickerList}>` — no scroll container of any
 * kind. With more direct conversations than fit the bottom sheet, the list
 * simply CLIPPED: rows past the fold existed but could never be reached, so
 * some contacts were impossible to add. GroupCallScreen's sibling invite
 * sheet has always used a height-bounded FlatList; this picker never got it.
 *
 * Pinned here:
 *  1. the candidate list is a FlatList (virtualized — the candidate set is
 *     every direct conversation, which can be large);
 *  2. it is height-bounded, so the sheet cannot grow past the screen and
 *     push its own Cancel button off the bottom;
 *  3. the sibling GroupCallScreen invite sheet keeps its own bounded list —
 *     the two sheets must not diverge again (that divergence is this bug).
 *
 * CallScreen mounts RN views, so the node project cannot import it —
 * comment-stripped source scan. The file is CRLF; nothing here is
 * `\n`-anchored (a `\n` anchor matches nothing and passes VACUOUSLY).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(file: string): string {
  return readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

describe('B-308 — the Add-to-call picker scrolls', () => {
  it('candidates render in a FlatList, not a mapped View', () => {
    const src = code('CallScreen.tsx');
    const at = src.indexOf('addPickerCandidates.length === 0');
    expect(at).toBeGreaterThan(-1);
    const sheet = src.slice(at, at + 1600);
    expect(sheet).toMatch(/<FlatList/);
    expect(sheet).toMatch(/data=\{addPickerCandidates\}/);
    // The unscrollable shape this bug shipped as:
    expect(sheet).not.toMatch(/addPickerCandidates\.map\(/);
  });

  it('the list is height-bounded so the sheet stays on screen', () => {
    const src = code('CallScreen.tsx');
    const at = src.indexOf('data={addPickerCandidates}');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at - 400, at + 400)).toMatch(/maxHeight/);
  });

  it('GroupCallScreen keeps its own bounded invite list', () => {
    const src = code('GroupCallScreen.tsx');
    const at = src.indexOf('data={inviteCandidates}');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at - 400, at + 400)).toMatch(/maxHeight/);
  });
});
