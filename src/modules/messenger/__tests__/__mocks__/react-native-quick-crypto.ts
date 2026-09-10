/**
 * Jest mock for `react-native-quick-crypto`.
 *
 * The real package is a native (JSI) module providing a Node-compatible
 * `crypto` API on Hermes. Under Jest we only have Node, so we re-export
 * Node's own `crypto` primitives the messenger code actually uses.
 *
 * Currently only the symmetric-cipher contract is needed —
 * `media/aesCbc.ts` calls `createCipheriv` / `createDecipheriv` for
 * attachment AES-256-CBC. Add more re-exports here if other modules
 * start importing quick-crypto directly under test.
 */
import {createCipheriv, createDecipheriv, createHmac, createHash, randomBytes} from 'node:crypto';

export {createCipheriv, createDecipheriv, createHmac, createHash, randomBytes};

// quick-crypto's default export carries the same surface; mirror it so
// both `import qc from '...'` and `import {createCipheriv} from '...'`
// (and the runtime `require(...).default` fallback) resolve.
const _default = {createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, install: () => {}};
export default _default;

export function install(): void { /* no-op in tests */ }
