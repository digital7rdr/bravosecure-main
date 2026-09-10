/**
 * Static source-scan regression for Issue 43 (Testing Issues V2, PDF p.48) —
 * "Live Mission Header Shows Duplicate Back and Next Controls".
 *
 * The two stacked top-left controls come from TWO different components, which is
 * why neither file looked wrong on its own:
 *
 *   - AgentLiveTrackerScreen renders MissionLeadConsoleScreen inside a slide-in
 *     Modal, and the panel has its own close button — a `chevron-right`, which
 *     is the "forward-style arrow" in the report;
 *   - MissionLeadConsoleScreen also rendered its own NavHeader back chevron.
 *
 * Worse than cosmetic: the console's back called navigation.goBack(), which does
 * NOT dismiss a Modal, so the lower control was DEAD in that context.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const CONSOLE = join(ROOT, 'src', 'screens', 'agent', 'MissionLeadConsoleScreen.tsx');
const TRACKER = join(ROOT, 'src', 'screens', 'agent', 'AgentLiveTrackerScreen.tsx');

function code(abs: string): string {
  const src = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

describe('Issue 43 — exactly one back control on the live mission console', () => {
  it('the console takes an `embedded` flag', () => {
    expect(code(CONSOLE)).toMatch(/MissionLeadConsoleScreen\(\{embedded = false\}: \{embedded\?: boolean\} = \{\}\)/);
  });

  it('embedded suppresses its own back chevron', () => {
    // NavHeader renders a chrome-less spacer when onBack is undefined (Issue 32),
    // so the title stays put and no dead control is drawn.
    expect(code(CONSOLE)).toMatch(/onBack=\{embedded \? undefined : \(\) => navigation\.goBack\(\)\}/);
  });

  it('embedded also drops the duplicated top inset (the panel supplies it)', () => {
    expect(code(CONSOLE)).toMatch(/paddingTop: embedded \? 0 : insets\.top/);
  });

  it('the tracker renders it EMBEDDED, so the overlay close is the only control', () => {
    const src = code(TRACKER);
    expect(src).toMatch(/<MissionLeadConsoleScreen embedded \/>/);
    // And the panel still owns a dismissal affordance.
    expect(src).toMatch(/onPress=\{closeOverlay\}[\s\S]{0,120}chevron-right/);
  });

  it('the overlay close clears the status bar', () => {
    expect(code(TRACKER)).toMatch(/s\.overlayHandleArea, \{top: insets\.top \+ 8\}/);
  });

  it('the STANDALONE route still has a working back control', () => {
    // MissionLeadConsole is also a registered screen (AgentNavigator). Removing
    // its back unconditionally would strand the user there.
    const src = code(CONSOLE);
    expect(src).toContain('navigation.goBack()');
    const nav = code(join(ROOT, 'src', 'navigation', 'AgentNavigator.tsx'));
    expect(nav).toMatch(/name="MissionLeadConsole"/);
  });
});
