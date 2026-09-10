/**
 * B-237-CW — owner re-broadcasts the group call key on JOIN, not only on HOST.
 *
 * Closes the "non-owner-hosted call never heals a behind-member" gap: the heal
 * used to fire only when the owner was the host. Now the owner re-broadcasts
 * whenever they participate. This pins the qualifying predicate; it changes no
 * security guard (a behind-member still heals only through the existing
 * accepting gate, and only an owner-signed create is ever re-broadcast).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {shouldOwnerResyncOnJoin, type OwnerResyncInput} from '../webrtc/callKeyResync';

const OWNER = 'user-owner';
function base(over?: Partial<OwnerResyncInput>): OwnerResyncInput {
  return {
    isHost:            false,
    ownUserId:         OWNER,
    groupOwner:        OWNER,
    groupHasMasterKey: true,
    isRealNamedGroup:  true,
    ...over,
  };
}

describe('shouldOwnerResyncOnJoin', () => {
  it('TRUE — the owner joins (not hosts) a real keyed group → re-broadcasts to heal', () => {
    expect(shouldOwnerResyncOnJoin(base())).toBe(true);
  });

  it('FALSE — the host does not double-broadcast (host boot already resyncs)', () => {
    expect(shouldOwnerResyncOnJoin(base({isHost: true}))).toBe(false);
  });

  it('FALSE — a non-owner joiner cannot heal (only owner-signed creates are accepted)', () => {
    expect(shouldOwnerResyncOnJoin(base({ownUserId: 'user-someone-else'}))).toBe(false);
    expect(shouldOwnerResyncOnJoin(base({groupOwner: 'user-someone-else'}))).toBe(false);
  });

  it('FALSE — ad-hoc / direct-alias call carriers are never re-broadcast by a joiner', () => {
    expect(shouldOwnerResyncOnJoin(base({isRealNamedGroup: false}))).toBe(false);
  });

  it('FALSE — nothing to re-broadcast when we hold no master key', () => {
    expect(shouldOwnerResyncOnJoin(base({groupHasMasterKey: false}))).toBe(false);
  });

  it('FALSE — missing own id (pre-auth / cold boot) never re-broadcasts', () => {
    expect(shouldOwnerResyncOnJoin(base({ownUserId: null}))).toBe(false);
    expect(shouldOwnerResyncOnJoin(base({ownUserId: undefined}))).toBe(false);
  });

  it('does not treat an owner whose id only matches a DIFFERENT group as owner', () => {
    // groupOwner must equal ownUserId exactly — no substring / prefix match.
    expect(shouldOwnerResyncOnJoin(base({groupOwner: OWNER + '-2'}))).toBe(false);
  });
});

describe('B-237-CW wiring — useGroupCall re-broadcasts on join through the predicate', () => {
  // useGroupCall pulls react-native-webrtc and cannot be imported here, so pin
  // the wire with a comment-stripped, CRLF-safe source scan: the boot path must
  // consult shouldOwnerResyncOnJoin and, when it passes, fire ensureCallGroupKey.
  const src = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'),
    'utf8',
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n');

  it('imports the predicate from callKeyResync', () => {
    // Import lines are structural (a commented-out import fails the build), and
    // the block-comment strip mis-parses this file's earlier regex literals, so
    // assert the import against the RAW source.
    expect(src).toContain("from './callKeyResync'");
    expect(src).toContain('shouldOwnerResyncOnJoin');
  });

  it('gates an ensureCallGroupKey re-broadcast on the predicate (comment-stripped)', () => {
    expect(code).toMatch(/shouldOwnerResyncOnJoin\(/);
    expect(code).toMatch(/ensureCallGroupKey\(/);
  });
});
