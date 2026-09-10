/**
 * FOUNDER-REPORTED ON DEVICE, 2026-08-05 — "when the channels are created they
 * should not appear in the messenger list for everyone. Why are they appearing?"
 *
 * They were. Both messenger lists DID filter department channels out, but each
 * built its filter from a NETWORK CALL (`departmentApi.listChannels()`), and a
 * filter that must finish a round trip before it can hide anything is a race,
 * not a filter:
 *
 *   • cold boot        — the set is EMPTY until the request lands, so every
 *                        channel is visible in the interim (what was seen);
 *   • offline          — the request never lands, so they stay visible ALL
 *                        SESSION;
 *   • non-member       — `listChannels` 403s and the catch leaves the set empty;
 *   • `GroupsScreen`   — its effect was MOUNT-only, so it never refreshed.
 *
 * It matters beyond tidiness: opening a channel from the messenger list lands on
 * `ChatScreen`, which renders the phone/video buttons frames A9 and M9 forbid in
 * a department channel.
 *
 * THE FIX asks the persisted store registry (`deptConversationIds` +
 * `deptGroupByChannel`) through the SAME `resolveDeptConversation` the
 * notification tap uses — so one predicate now answers both "hide this row" and
 * "route this tap", instead of two implementations that could disagree.
 *
 * WHY A SOURCE SCAN. Both screens mount the full messenger runtime, and the rule
 * is "the store predicate is present at the filter site AND the network set is
 * not the only gate" — a presence-and-absence pair at a specific decision site,
 * which is what a scan is for. The predicate's own behaviour is covered by
 * `deptChannelTarget`'s tests.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Line-anchored comment stripping. A naive `/\/\*[\s\S]*?\*\//` believes the
 * MIME wildcard in these very files (`getDocumentAsync({type: '*' + '/*'})`) and
 * deletes thousands of lines of real code, which would make these assertions
 * pass VACUOUSLY. See src/__tests__/sourceScanSafety.test.ts.
 */
function code(sentinel: string, ...rel: string[]): string {
  const out = readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .split(/\r?\n/)
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
  // A SENTINEL, not a size ratio. The first version of this guard compared
  // stripped length against 30% of the original and failed on the hook below —
  // a small, heavily-documented file legitimately has a low code ratio, so the
  // heuristic flagged a healthy file while a big file could lose a whole
  // function and still pass. A token that must survive is exact.
  if (!out.includes(sentinel)) {
    throw new Error(`comment stripper ate ${rel.join('/')} — "${sentinel}" did not survive`);
  }
  return out;
}

const HOME   = code('conversationOrder',      'src', 'screens', 'messenger', 'MessengerHomeScreen.tsx');
const GROUPS = code('conversationToGroupItem', 'src', 'screens', 'messenger', 'GroupsScreen.tsx');
const HOOK   = code('useIsDeptConversation',  'src', 'screens', 'messenger', 'useDeptConversationFilter.ts');
// B-593 — the WRITE side. Every constant above reads the registry; these two
// are the only places that can put a freshly-minted channel INTO it.
const PROVISION = code('provisionOnce', 'src', 'modules', 'messenger', 'orgWorkspace', 'provisionChannel.ts');
const CHANNELS  = code('onGroupLearned', 'src', 'screens', 'messenger', 'DepartmentChannelsScreen.tsx');
const NAV       = code('armDeptConversationRegistry', 'src', 'navigation', 'MainNavigator.tsx');

describe('department channels never appear in the messenger lists', () => {
  it('the shared predicate reads the STORE, not the network', () => {
    expect(HOOK).toMatch(/useMessengerStore\(s => s\.deptConversationIds\)/);
    expect(HOOK).toMatch(/useMessengerStore\(s => s\.deptGroupByChannel\)/);
    expect(HOOK).toMatch(/resolveDeptConversation\(/);
    // A network call here would reintroduce the race in the shared place.
    expect(HOOK).not.toMatch(/departmentApi|fetch\(|authHttp/);
  });

  it('it reuses the ROUTING rule rather than restating it', () => {
    // Two implementations of "is this departmental" is the duplicate-copy shape
    // this repo keeps shipping; the tap and the list must not diverge.
    expect(HOOK).toMatch(/from '@\/modules\/messenger\/push\/deptChannelTarget'/);
  });

  describe.each([
    ['MessengerHomeScreen', HOME],
    ['GroupsScreen',        GROUPS],
  ])('%s', (_name, src) => {
    it('applies the store predicate at the list filter site', () => {
      expect(src).toMatch(/useIsDeptConversation/);
      expect(src).toMatch(/&& !isDept\(c\.id\)/);
    });

    it('does not gate hiding on the network set ALONE', () => {
      // The network set may still narrow further, but a filter line whose only
      // department test is `deptGroupIds` is the bug returning.
      const filterLines = src.split('\n').filter(l => l.includes('deptGroupIds.has(c.id)'));
      expect(filterLines.length).toBeGreaterThan(0);
      for (const line of filterLines) {
        expect(line).toMatch(/isDept\(c\.id\)/);
      }
    });

    it('keeps the predicate in the memo dependencies', () => {
      // Omitting it freezes the list at its first-paint value, so rows that
      // should vanish once the registry arms never do.
      expect(src).toMatch(/deptGroupIds, isDept\]/);
    });
  });
});

/**
 * B-593 (founder, 2026-08-20) — "in messenger list i can see broadcast that was
 * created in the departmental chat".
 *
 * The 2026-08-05 fix above made the filter read a PERSISTED registry instead of
 * a live fetch — and that is still right. What it could not see is that the
 * registry had no LOCAL WRITER: every id in it came from a `listChannels`
 * response, so hiding a channel was still a race against the network, one
 * layer down. The scan above passes on a device where no registry will EVER
 * contain the row.
 *
 * The minting path holds the channel id and the conversation it just created
 * in the same hand. These pins say it must not drop them.
 */
describe('B-593 — the registry is WRITTEN at mint time, not just read', () => {
  it('provisionOnce records the id it just minted, BEFORE registerGroup', () => {
    // Before, not after: an interrupted provision (killed app, network drop)
    // otherwise strands a local group row no registry will ever name.
    const mint = PROVISION.indexOf('createGroupChat(');
    const remember = PROVISION.indexOf('rememberDeptConversation(');
    const register = PROVISION.indexOf('registerGroup(');
    expect(mint).toBeGreaterThan(-1);
    expect(remember).toBeGreaterThan(mint);
    expect(register).toBeGreaterThan(remember);
  });

  it('…and the CANONICAL id too, when a racing admin won the register', () => {
    // The registry is additive by design, so recording BOTH is what makes the
    // losing fork row permanently hideable. A redelivered `create` re-mints
    // that row, so deleting it does not stick — only the registry answers.
    expect(PROVISION).toMatch(/groupConversationId !== conversationId/);
    expect((PROVISION.match(/rememberDeptConversation\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('the admin self-heal sweep records what it provisions', () => {
    // THE LEAK THE FOUNDER HIT: the sweep provisions every unprovisioned
    // channel it administers — `#broadcast` is created server-side on every
    // channel create with the org account seeded as admin — and never
    // navigates, so the DepartmentChat focus writer never ran.
    expect(CHANNELS).toMatch(/rememberDeptConversation\(res\.groupConversationId\)/);
  });

  it('onGroupLearned records it, instead of only setting React state', () => {
    const at = CHANNELS.indexOf('onGroupLearned');
    expect(at).toBeGreaterThan(-1);
    expect(CHANNELS.slice(at, at + 600)).toMatch(/rememberDeptConversation\(gid\)/);
  });

  it('the boot arming runs AFTER store.setOwner, never before it', () => {
    /**
     * A first pass hoisted this above the degraded-session early return, to
     * close the claims-only-boot leak. Round 1 caught why that is worse:
     * `setOwner` snapshots the live `deptConversationIds` into the OUTGOING
     * owner's slice and then replaces it from the incoming owner's, so an arm
     * that resolves first writes user B's channel ids into user A's persisted
     * registry and then has its own result discarded.
     *
     * One HTTP round trip against one AsyncStorage read is a race the network
     * usually loses — and 'usually' is the shape of a shipped bug. The
     * degraded boot defers the whole messenger for the same reason, so
     * leaving it unarmed for that rare boot is the honest trade.
     */
    const owner = NAV.indexOf('store.setOwner(');
    const arm = NAV.indexOf('armDeptConversationRegistry()');
    expect(owner).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(owner);
  });

  it('GroupsScreen refreshes on FOCUS, not only on mount', () => {
    // A channel provisioned from a sibling tab while this screen was already
    // mounted never reached a mount-only effect.
    expect(GROUPS).toMatch(/useFocusEffect\(/);
  });
});
