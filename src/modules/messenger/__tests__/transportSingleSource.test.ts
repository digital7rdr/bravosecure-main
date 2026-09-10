/**
 * B-152 — one implementation per transport client.
 *
 * `runtime/certCache.ts`, `transport/relayClient.ts` and
 * `transport/senderCertClient.ts` were orphaned copies of code that
 * production does not run: `productionRuntime.ts` builds its relay, keys,
 * sender-cert and cert-cache objects from `@bravo/messenger-core`. The
 * copies had already drifted — the local `SenderCertCache` lacked
 * `getIssued()` and `revokeCurrentAndInvalidate()`, both of which the
 * runtime calls, and it threw away a still-valid cert when a proactive
 * refresh failed inside the 10-minute margin.
 *
 * A duplicate nothing imports is worse than one that is wrong: no test
 * exercises it, so it drifts silently, and the next reader cannot tell
 * which copy is authoritative. They were deleted; this keeps them gone
 * and keeps the runtime pointed at the shared package.
 *
 * If a local client is ever legitimately needed again, this test should
 * be updated DELIBERATELY, with the reason — not deleted to make a red
 * run green.
 */

import {existsSync} from 'node:fs';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const MESSENGER = join(process.cwd(), 'src', 'modules', 'messenger');
const RUNTIME   = join(MESSENGER, 'runtime', 'productionRuntime.ts');

describe('B-152 — the dead duplicates stay dead', () => {
  it.each([
    ['runtime/certCache.ts', join(MESSENGER, 'runtime', 'certCache.ts')],
    ['transport/relayClient.ts', join(MESSENGER, 'transport', 'relayClient.ts')],
    ['transport/senderCertClient.ts', join(MESSENGER, 'transport', 'senderCertClient.ts')],
  ])('%s does not exist', (_label, path) => {
    expect(existsSync(path)).toBe(false);
  });

  it('the transport barrel no longer re-exports them', () => {
    const barrel = readFileSync(join(MESSENGER, 'transport', 'index.ts'), 'utf8');
    expect(barrel).not.toContain('./relayClient');
    expect(barrel).not.toContain('./senderCertClient');
  });
});

describe('B-152 — production resolves its clients from the shared package', () => {
  it('productionRuntime imports the transport clients from @bravo/messenger-core', () => {
    const src = readFileSync(RUNTIME, 'utf8');
    // The import list is long and reformatted often, so assert on the
    // core-package import BLOCK rather than a single-line pattern.
    const coreImports = [...src.matchAll(/import\s*\{[\s\S]*?\}\s*from\s*'@bravo\/messenger-core';/g)]
      .map(m => m[0])
      .join('\n');
    for (const symbol of ['RelayHttpClient', 'KeysHttpClient', 'SenderCertClient', 'SenderCertCache']) {
      expect(coreImports).toContain(symbol);
    }
  });

  it('nothing in the messenger module imports a LOCAL relay/senderCert client', () => {
    const src = readFileSync(RUNTIME, 'utf8');
    expect(src).not.toMatch(/from\s*'\.\/certCache'/);
    expect(src).not.toMatch(/from\s*'\.\.\/transport\/relayClient'/);
    expect(src).not.toMatch(/from\s*'\.\.\/transport\/senderCertClient'/);
  });

  it('keysClient is DELIBERATELY kept — vaultOps imports it directly', () => {
    // The counter-example that stops this test being read as "delete every
    // local client": this one has a real consumer.
    expect(existsSync(join(MESSENGER, 'transport', 'keysClient.ts'))).toBe(true);
    const vaultOps = readFileSync(join(MESSENGER, 'vault', 'vaultOps.ts'), 'utf8');
    expect(vaultOps).toContain("from '../transport/keysClient'");
  });
});
