/**
 * Chat-list multi-select (founder 2026-08-01) — long-press a chat row to
 * enter selection mode, batch Pin / Mute / Delete from the header toolbar.
 *
 * MessengerHomeScreen mounts RN + gesture-handler, so the wiring is pinned
 * by reading the source (same pattern as vaultMultiUpload / sendErrorText).
 * CRLF trap: never anchor a regex on bare \n — these files are CRLF.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'MessengerHomeScreen.tsx');

/** CRLF-normalised source with comments stripped (vaultMultiUpload recipe). */
function code(): string {
  const src = readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) {inBlock = false;}
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) {inBlock = true;}
      continue;
    }
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

describe('chat-list multi-select wiring', () => {
  it('a row long-press enters selection mode', () => {
    const src = code();
    expect(src).toContain('onLongPress={handleLongPress}');
    expect(src).toMatch(/onLongPressRow\(c\.id\)/);
    expect(src).toMatch(/setSelectedChats\(prev => prev \?\? new Set\(\[id\]\)\)/);
  });

  it('tap in selection mode TOGGLES instead of opening the chat', () => {
    const src = code();
    const handler = src.slice(src.indexOf('const handlePress'), src.indexOf('const handleLongPress'));
    expect(handler).toContain('if (selecting) {onToggleSelect(c.id); return;}');
  });

  it('swipe actions are disabled while selecting (one action surface at a time)', () => {
    expect(code()).toMatch(/enabled=\{!selecting\}/);
  });

  it('the memo comparator sees selection props — stale-row trap', () => {
    const src = code();
    expect(src).toMatch(/prev\.selecting !== next\.selecting/);
    expect(src).toMatch(/prev\.selected\s+!== next\.selected/);
  });

  it('batch actions drive the existing store APIs', () => {
    const src = code();
    expect(src).toMatch(/setConversationPinned\(id, pin\)/);
    expect(src).toMatch(/setConversationMuted\(id, mute\)/);
    expect(src).toMatch(/removeConversation\(id\)/);
  });

  it('batch delete confirms before removing (destructive gate)', () => {
    const src = code();
    const start = src.indexOf('const batchDelete');
    const body = src.slice(start, src.indexOf('const renderChatRow', start));
    expect(body).toContain('Alert.alert');
    const confirmIdx = body.indexOf('Alert.alert');
    const removeIdx  = body.indexOf('removeConversation(id)');
    expect(confirmIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(confirmIdx);
  });

  it('hardware back exits selection mode instead of leaving the screen', () => {
    const src = code();
    const start = src.indexOf("BackHandler.addEventListener('hardwareBackPress'");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 220);
    expect(block).toContain('setSelectedChats(null)');
    expect(block).toContain('return true;');
  });
});
