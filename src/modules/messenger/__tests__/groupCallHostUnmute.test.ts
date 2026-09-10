/**
 * "In group call the admin can mute a person — also add an option unmute; that
 * option should appear when someone is muted by admin, to admin."
 *
 * The server supported this from the start: `sfu.mute-target` takes
 * `{unmute: true}` and emits `sfu.unmuted`, and the client's RECEIVE side has
 * always handled `sfu.unmuted` (re-enables the track, clears isMuted). Only the
 * SEND side was missing, so a host could silence someone with no way to give
 * their mic back.
 *
 * Both files load native modules the node project cannot, so this is a source
 * scan. Line-based — these files are CRLF.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const R = process.cwd();
function code(rel: string[]): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(join(R, ...rel), 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

const hook   = code(['src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts']);
const screen = code(['src', 'screens', 'messenger', 'GroupCallScreen.tsx']);
const server = code(['apps', 'messenger-service', 'src', 'gateway', 'messenger.gateway.ts']);

describe('a host can give a muted participant their mic back', () => {
  it('the server already accepts the unmute flag', () => {
    // Proves the client was the only missing half — if this ever stops being
    // true the client change is sending into a void.
    expect(server).toMatch(/unmute: data\.unmute === true/);
    expect(server).toMatch(/data\.unmute \? 'sfu\.unmuted' : 'sfu\.muted'/);
  });

  it('muteParticipant can now send it', () => {
    expect(hook).toMatch(/muteParticipant = useCallback\(async \(tag: string, unmute = false\)/);
    expect(hook).toMatch(/'sfu\.mute-target', \{roomId, targetTag: tag, unmute\}/);
  });

  it('the host tracks who IT muted', () => {
    // Not the tile's mic state: a participant who muted themselves is not the
    // host's to undo.
    expect(hook).toMatch(/const \[hostMutedTags, setHostMutedTags\] = useState<string\[\]>\(\[\]\)/);
    expect(hook).toMatch(/hostMutedTags:\s+string\[\]/);
  });

  it('the list is kept in sync in BOTH directions', () => {
    // Only removing on unmute would leave a stale entry offering Unmute
    // forever; only adding would never offer it at all.
    expect(hook).toMatch(/unmute \? prev\.filter\(t => t !== tag\) : \(prev\.includes\(tag\) \? prev : \[\.\.\.prev, tag\]\)/);
  });

  it('the host sheet swaps Mute for Unmute', () => {
    expect(screen).toMatch(/const hostMuted = call\.hostMutedTags\.includes\(tag\)/);
    expect(screen).toMatch(/text: 'Unmute', onPress: \(\) => \{ void call\.muteParticipant\(tag, true\); \}/);
  });

  it('it is one option or the other, never both', () => {
    // Two rows would let a host "mute" someone already muted, which the server
    // treats as a no-op and reads as a broken button.
    expect(screen).toMatch(/hostMuted$/m);
    expect(screen).toMatch(/\? \{text: 'Unmute'/);
    expect(screen).toMatch(/: \{text: 'Mute',/);
  });

  it('the receive side that makes it work is untouched', () => {
    // The host's request is pointless if the target no longer re-enables.
    expect(hook).toMatch(/frame\.event === 'sfu\.unmuted'/);
    expect(hook).toMatch(/if \(t\) \{ t\.enabled = true; \}/);
  });
});
