/**
 * Scope v2 Phase 4, R5-B2 — every forward INTO `moveBytesToVault` must carry the
 * file's real conversation, not a stated `null`.
 *
 * The choke point can only refuse what it is told. R4-B3 established that a
 * required `string | null` pins existence but not correctness — `null`
 * typechecks — and then asserted the value at exactly ONE of five sites
 * (`AttachmentFileViewer → FileViewer`). The four forwards into the vault were
 * left unpinned, and `conversationId: null` at each of them was green across the
 * whole app project.
 *
 * Two of the four have NO second guard at all:
 *   - `filesMultiSelect.runBatchVaultMove` — the select-all batch lane;
 *   - `FilesScreen`'s per-row Move-to-Vault shield.
 * Inside the workspace shell FilesScreen shows company rows EXCLUSIVELY, so
 * those two lines are the only thing between a select-all and a personal copy
 * of every company file.
 *
 * `runBatchVaultMove` is exercised behaviourally (it is pure and injectable);
 * the two screen call sites are pinned at their decision site by source scan,
 * because mounting them for this would test the mock rather than the forward.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {runBatchVaultMove} from '../filesMultiSelect';

const strip = (s: string) => s
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const read = (rel: string) => strip(readFileSync(join(process.cwd(), rel), 'utf8'));

describe('the batch lane forwards each row\'s own conversation', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'm1', name: 'f.pdf', mimeType: 'application/pdf',
    conversationId: 'conv-company', inVault: false, ...over,
  });

  it('passes the row conversation through to the vault', async () => {
    // Typed: a bare jest.fn() infers a zero-length tuple for mock.calls, so
    // reading calls[0][0] is a type error. The arg type is the contract here.
    const moveToVault = jest.fn(async (_p: {conversationId: string | null}) => ({ok: true as const}));
    await runBatchVaultMove([row()], {
      resolveBytes: async () => new Uint8Array([1]),
      moveToVault,
    });
    expect(moveToVault).toHaveBeenCalledWith(
      expect.objectContaining({conversationId: 'conv-company'}));
    // Explicit: `null` is the regression, and it typechecks.
    expect(moveToVault.mock.calls[0][0].conversationId).not.toBeNull();
  });

  it('passes each row its OWN conversation in a mixed selection', async () => {
    // A constant would satisfy the single-row case; two rows cannot.
    const moveToVault = jest.fn(async (_p: {conversationId: string | null}) => ({ok: true as const}));
    await runBatchVaultMove(
      [row({id: 'a', conversationId: 'conv-company'}), row({id: 'b', conversationId: 'conv-dm'})],
      {resolveBytes: async () => new Uint8Array([1]), moveToVault},
    );
    expect(moveToVault.mock.calls.map(c => c[0].conversationId))
      .toEqual(['conv-company', 'conv-dm']);
  });

  it('a refused company file fails only ITSELF, not the whole batch', async () => {
    // `company_file` must land in the per-file `failed` bucket, not `fatal` —
    // otherwise one company row in a mixed selection aborts every personal one.
    const moveToVault = jest.fn(async (p: {conversationId: string | null}) =>
      (p.conversationId === 'conv-company'
        ? {ok: false as const, reason: 'company_file', message: 'no'}
        : {ok: true as const}));
    const out = await runBatchVaultMove(
      [row({id: 'a', conversationId: 'conv-company'}), row({id: 'b', conversationId: 'conv-dm'})],
      {resolveBytes: async () => new Uint8Array([1]), moveToVault},
    );
    expect(out.moved).toBe(1);
    expect(out.failed).toEqual(['f.pdf']);
    expect(out.fatal).toBeNull();
    expect(out.cancelled).toBe(false);
  });
});

describe('every screen forward states a real conversation, never null', () => {
  it('FilesScreen row shield forwards the row conversation', () => {
    const src = read(join('src', 'screens', 'messenger', 'FilesScreen.tsx'));
    expect(src).toMatch(/conversationId: r\.conversationId,/);
    // B-663 batch — the direct device→vault upload lane is the ONE legitimate
    // null (a local pick has no source conversation, same rule as VaultScreen).
    // Every message-derived row must still forward its real conversation.
    const nulls = src.match(/conversationId: null,/g) ?? [];
    expect(nulls).toHaveLength(1);
  });

  it('VaultScreen forwards the company file\'s conversation, and null ONLY for a local pick', () => {
    const src = read(join('src', 'screens', 'messenger', 'VaultScreen.tsx'));
    expect(src).toMatch(/conversationId: f\.conversationId,/);
    // The single legitimate null is the camera / document-picker upload, which
    // genuinely has no source conversation.
    const nulls = src.match(/conversationId: null,/g) ?? [];
    expect(nulls).toHaveLength(3);   // one upload + two personal vault rows
  });

  it('FileViewer forwards the viewed file\'s conversation', () => {
    const src = read(join('src', 'modules', 'messenger', 'ui', 'FileViewer.tsx'));
    expect(src).toMatch(/conversationId: file\.conversationId,/);
    expect(src).not.toMatch(/conversationId: null,/);
  });

  it('the batch lane forwards the row conversation', () => {
    const src = read(join('src', 'screens', 'messenger', 'filesMultiSelect.ts'));
    expect(src).toMatch(/conversationId: f\.conversationId,/);
    expect(src).not.toMatch(/conversationId: null,/);
  });

  /**
   * THERE ARE FIVE FORWARDS, NOT FOUR. `FileViewer` has two upstream builders
   * and the round-5 work pinned only `AttachmentFileViewer`. ChatScreen is a
   * live company-file path: `fcmBootstrap` deep-links a message tap to 'Chat'
   * and `messengerDeepLink` has no DepartmentChat target at all, so a channel
   * notification lands here.
   */
  it('ChatScreen forwards the shown message\'s conversation', () => {
    const src = read(join('src', 'screens', 'messenger', 'ChatScreen.tsx'));
    expect(src).toMatch(/conversationId: shownMsg\.conversation_id,/);
  });

  /**
   * The two `AttachmentViewTarget` builders feed the same choke point. Required
   * pins existence, not correctness — a bogus non-null id typechecks and would
   * silently stop the refusal.
   */
  it('both AttachmentViewTarget builders carry the real conversation', () => {
    const chat = read(join('src', 'screens', 'messenger', 'DepartmentChatScreen.tsx'));
    // `\s+` — this file aligns its object values, so a single-space anchor
    // misses a value that is genuinely there.
    expect(chat).toMatch(/conversationId:\s+m\.conversation_id,/);
    const files = read(join('src', 'screens', 'messenger', 'FilesScreen.tsx'));
    expect(files).toMatch(/conversationId:\s+f\.conversationId,/);
  });
});

/**
 * R6 — the COLD-BOOT leg of the per-owner registry.
 *
 * Round 5 fixed the owner-switch leg (snapshot written, never restored). The
 * persist legs have the same asymmetry and no coverage: dropping the field from
 * `partialize` or from `onRehydrateStorage` makes every device boot with an
 * empty registry, so the vault stops refusing every company conversation it has
 * not re-fetched since launch.
 */
/**
 * R7-B1 — the refusal registry must be armed somewhere EVERY shell reaches.
 *
 * It is otherwise armed only by opening a channel thread or a Vault/Files
 * surface. A channel notification deep-links straight to ChatScreen, and the
 * deep link passes `initial: false` so MessengerHome is seeded BENEATH the
 * pushed Chat — mounted but never focused, so a focus effect there never runs.
 * In the Agent shell MessengerHome is a sibling route that never mounts at all.
 * So the cold notification tap, the default first contact with a company file,
 * found the registry blind and Move-to-Vault succeeded.
 *
 * MainNavigator's owner-set effect is the one point all three shells and the
 * cold deep-link share, and it runs before any shell mounts.
 */
describe('the company-file refusal is armed at messenger boot', () => {
  const main = read(join('src', 'navigation', 'MainNavigator.tsx'));

  it('MainNavigator calls the arming on owner set', () => {
    // Only the CALL SITE is scanned. What the function DOES is tested
    // behaviourally in companyShelfFailClosed — a scan over an inlined version
    // survived inverting its guard (`if (!ch.group_conversation_id)`), which
    // records nothing while keeping every asserted token.
    expect(main).toMatch(/armDeptConversationRegistry\(\)/);
  });

  it('the arming cannot break boot', () => {
    const from = main.indexOf('armDeptConversationRegistry()');
    expect(from).toBeGreaterThan(-1);
    // Fire-and-forget, inside a try — a dept-API 403 is the expected answer for
    // every non-org account and must not stop the runtime configuration below.
    expect(main.slice(from - 200, from)).toMatch(/try \{/);
    expect(main.slice(from - 20, from)).toMatch(/void /);
  });

  it('it is NOT wired to a focus effect on a screen the deep link seeds beneath', () => {
    // The failure mode this replaced: a focus effect on MessengerHomeScreen,
    // which `initial: false` mounts without focusing.
    const link = read(join('src', 'navigation', 'messengerDeepLink.ts'));
    expect(link).toMatch(/initial: false/);
  });
});

/**
 * M49 — the rows-memo scope deps.
 *
 * Dropping `companyConvIds, scopeToCompany` makes the workspace Vault tab keep
 * a list built under the PREVIOUS membership answer, so a revoked membership
 * goes on showing company files until some unrelated input changes. A render
 * test cannot see it: the fixtures return a fresh array from
 * `selectMediaMessages` on every call, so the memo always recomputes anyway.
 * ESLint flags it only as a WARNING and `npm run lint` has no
 * `--max-warnings 0`, so a source scan is the durable pin.
 */
describe('the workspace scope is a real memo dependency', () => {
  const files = read(join('src', 'screens', 'messenger', 'FilesScreen.tsx'));

  it('the rows memo depends on the membership answer and the shell flag', () => {
    const at = files.indexOf('const rows = useMemo<FileRow[]>');
    expect(at).toBeGreaterThan(-1);
    const deps = files.slice(at, files.indexOf('const visible', at));
    expect(deps).toMatch(/\}, \[[^\]]*companyConvIds[^\]]*\]\)/);
    expect(deps).toMatch(/\}, \[[^\]]*scopeToCompany[^\]]*\]\)/);
  });

  it('the icon helper keeps its image and video branches', () => {
    // Without them every photo — the most common channel attachment — renders
    // as a generic grey file row on the Company shelf.
    const vault = read(join('src', 'screens', 'messenger', 'VaultScreen.tsx'));
    // Slice to docIconFor's OWN body. Asserting the token file-wide passed via
    // `categorize`, which has the identical `startsWith('image/')` check — the
    // "assert the decision site, not the token" trap, in my own test.
    const at = vault.indexOf('function docIconFor');
    expect(at).toBeGreaterThan(-1);
    const body = vault.slice(at, vault.indexOf('\n}', at));
    expect(body).toMatch(/mime\.startsWith\('image\/'\)/);
    expect(body).toMatch(/mime\.startsWith\('video\/'\)/);
  });
});

describe('the dept-conversation registry survives a cold boot', () => {
  const store = read(join('src', 'modules', 'messenger', 'store', 'messengerStore.ts'));

  it('is written to the persisted slice', () => {
    expect(store).toMatch(/deptConversationIds: s\.deptConversationIds,/);
  });

  it('is read back on rehydrate', () => {
    expect(store).toMatch(/state\.deptConversationIds = slice\.deptConversationIds \?\? \{\};/);
  });

  it('is snapshotted AND restored per owner', () => {
    expect(store).toMatch(/deptConversationIds: immerCurrent\(s\.deptConversationIds\)/);
    expect(store).toMatch(/s\.deptConversationIds = incoming\?\.deptConversationIds \?\? \{\}/);
  });
});

/**
 * ROUND 9 — the pin round 8 believed it already had.
 *
 * R8-1 unified the affordance gate and the refusal onto ONE predicate. The
 * mutation recorded as proving it — `canMoveToVault` re-deriving from the
 * narrow `deptConversationIds` — does NOT fail: the FilesScreen fixture mocks
 * `isDepartmentConversation` as `id => !!deptConversationIds[id]`, so under that
 * fixture the two readings are literally the same function and no render
 * assertion can separate them. What the real predicate adds is the
 * `deptGroupByChannel` fallback, which is the entire population R8-1 exists for
 * (an install upgraded from before the registry). A scan at the decision site is
 * the only pin that can see the difference.
 *
 * Not a leak either way — `moveBytesToVault` still refuses — but it restores the
 * download-then-refuse cost R6-B1 removed and makes a row disagree with the
 * viewer it opens.
 */
describe('the affordance gate delegates to the SHARED predicate (R8-1)', () => {
  const files = read(join('src', 'screens', 'messenger', 'FilesScreen.tsx'));

  it('canMoveToVault asks isDepartmentConversation, not a narrower source', () => {
    const at = files.indexOf('const canMoveToVault');
    expect(at).toBeGreaterThan(-1);
    // The DECISION SITE only. Asserting the token file-wide passes on the
    // import line alone — the trap M50 fell into inside this very phase.
    const site = files.slice(at, files.indexOf('\n', at));
    expect(site).toMatch(/isDepartmentConversation\(/);
    // The two sources it has already regressed to: R7-B3 read the narrow server
    // list, R8-1 read the registry directly and lost the pointer-map fallback.
    expect(site).not.toMatch(/deptConversationIds/);
    expect(site).not.toMatch(/companyConvIds/);
  });

  it('keeps BOTH store subscriptions that make the gate reactive', () => {
    // The predicate reads getState(), so the ANSWER is always current — but the
    // screen only re-renders when a SUBSCRIBED value changes. Drop either and a
    // mounted Files tab keeps stale shields until something unrelated re-renders
    // it. A render fixture cannot see this: it never mutates the store after
    // mount, and this suite's store mock is a plain selector function.
    const from = files.indexOf('const scopeToCompany');
    const to = files.indexOf('const canMoveToVault');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const block = files.slice(from, to);
    expect(block).toMatch(/useMessengerStore\(s => s\.deptConversationIds\)/);
    expect(block).toMatch(/useMessengerStore\(s => s\.deptGroupByChannel\)/);
  });
});

/**
 * M49's sibling, missed in round 8. The FilesScreen rows memo got a deps scan;
 * the hook's OWN memos did not — and their fixture is blind for the same
 * structural reason, one level worse: the store mock rebuilds its state object
 * on every call, so `messages` changes identity each render and the memo
 * recomputes whatever the deps say.
 *
 * Dropping `channels` here is the one staleness in Phase 4 with a
 * confidentiality edge: the shelf would keep serving the list derived under the
 * PREVIOUS membership answer, so a removed member goes on seeing company files
 * until some unrelated input happens to change.
 */
describe('the company shelf memoises on the membership answer', () => {
  const hook = read(join('src', 'modules', 'messenger', 'vault', 'useCompanyShelf.ts'));

  it('useCompanyShelf depends on channels', () => {
    const at = hook.indexOf('export function useCompanyShelf');
    expect(at).toBeGreaterThan(-1);
    const body = hook.slice(at, hook.indexOf('\n}', at));
    expect(body).toMatch(/\[[^\]]*\bchannels\b[^\]]*\]/);
  });

  it('useCompanyConversationIds depends on channels', () => {
    const at = hook.indexOf('export function useCompanyConversationIds');
    expect(at).toBeGreaterThan(-1);
    const body = hook.slice(at, hook.indexOf('\n}', at));
    expect(body).toMatch(/\[[^\]]*\bchannels\b[^\]]*\]/);
  });
});
