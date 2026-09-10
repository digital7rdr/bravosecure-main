/**
 * Jest mock for `@craftzdog/react-native-buffer` (messenger-crypto).
 *
 * The package is a RN-optimised re-implementation of Node's Buffer. Node
 * already HAS Buffer with identical semantics, so re-exporting the real
 * thing is exact rather than a simulation — unlike the fs/sqlite stubs,
 * there is no behaviour here to fake.
 */
export {Buffer} from 'node:buffer';
export default {Buffer: require('node:buffer').Buffer};
