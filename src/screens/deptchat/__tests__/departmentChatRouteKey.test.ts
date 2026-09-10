/**
 * `DepartmentChat` must be keyed by channel, on BOTH shells.
 *
 * Without `getId`, React Navigation matches by route NAME: navigating to a
 * different channel reuses the mounted screen and only swaps its params. That
 * screen seeds `groupConversationId`, `myRole` and `postMode` into state once
 * and adopts a new group id only when its own is null — so the header renamed
 * itself to channel B while the transcript, and every message SENT, stayed on
 * channel A's Signal group. Delivery to the wrong member set, with the UI
 * insisting otherwise.
 *
 * The router matches on a TRUTHY id, so an absent `channelId` degrades silently
 * back to name-matching. Hence the second half: every navigate site must pass
 * one.
 */
import {readFileSync, readdirSync, statSync} from 'fs';
import {join} from 'path';

/** Line-anchored: the greedy form eats real code in this repo's known hazards. */
function strip(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const NAVIGATORS = [
  join(process.cwd(), 'src', 'navigation', 'MessengerNavigator.tsx'),
  join(process.cwd(), 'src', 'navigation', 'DepartmentalNavigator.tsx'),
];

describe('the DepartmentChat route is keyed by channel', () => {
  it.each(NAVIGATORS)('%s registers it with a channelId getId', file => {
    const src = strip(file);
    const at = src.indexOf('name="DepartmentChat"');
    expect(at).toBeGreaterThan(-1);
    // The registration element, not the whole file: a `getId` on some OTHER
    // screen would satisfy a file-wide search and pin nothing.
    const block = src.slice(at, at + 600);
    // NOT `[^}]*` — that stops at the `}` inside `({params})` and never reaches
    // `channelId`, so the assertion fails on correct code. The weak-anchor trap,
    // caught only because it failed loudly rather than passing vacuously.
    expect(block).toMatch(/getId=\{[\s\S]{0,200}?channelId/);
  });

  it('EVERY navigate to it passes a channelId — a falsy id degrades to name-matching', () => {
    const roots = [
      join(process.cwd(), 'src', 'screens', 'deptchat'),
      join(process.cwd(), 'src', 'screens', 'messenger'),
      join(process.cwd(), 'src', 'modules', 'messenger', 'push'),
    ];
    let sites = 0;
    for (const dir of roots) {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        if (!statSync(file).isFile() || !/\.tsx?$/.test(name)) {continue;}
        const src = strip(file);
        for (const m of src.matchAll(/['"]DepartmentChat['"]/g)) {
          const after = src.slice(m.index ?? 0, (m.index ?? 0) + 700);
          if (!/channelId/.test(after)) {continue;}   // a type/route decl, not a navigate
          sites++;
          // Not merely present — ASSIGNED from something. `channelId: undefined`
          // and a bare mention in a comment both read as "present".
          expect(`${name}:${/\bchannelId:\s*[A-Za-z_$][\w$.?[\]']*/.test(after)}`)
            .toBe(`${name}:true`);
        }
      }
    }
    // Anti-vacuity: if the navigate shape changes and the matcher stops finding
    // anything, this trips instead of passing on an empty sweep.
    expect(sites).toBeGreaterThanOrEqual(2);
  });
});
