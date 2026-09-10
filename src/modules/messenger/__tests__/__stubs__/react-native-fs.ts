/**
 * Jest mock for `react-native-fs` (messenger-crypto project).
 *
 * The real package ships Flow-typed source the node project does not
 * transform ("Unexpected token ':'"), and `media/mediaFiles.ts` imports
 * it at module scope — putting it in productionRuntime's import chain.
 *
 * Every filesystem call REJECTS. Same posture as the op-sqlite stub: the
 * goal is to make modules LOADABLE, not to simulate a filesystem. A
 * plausible in-memory FS would let suites assert against storage
 * semantics (paths, permissions, the private-cache guarantee this module
 * exists to enforce) that the device does not share.
 */
class RnfsMockError extends Error {
  constructor(op: string) {
    super(`react-native-fs is not available under jest (${op}). Mock the media seam your suite needs.`);
    this.name = 'RnfsMockError';
  }
}
const reject = (op: string) => () => Promise.reject(new RnfsMockError(op));

const RNFS = {
  DocumentDirectoryPath: '/mock/documents',
  CachesDirectoryPath:   '/mock/caches',
  TemporaryDirectoryPath:'/mock/tmp',
  readFile:   reject('readFile'),
  writeFile:  reject('writeFile'),
  unlink:     reject('unlink'),
  exists:     reject('exists'),
  mkdir:      reject('mkdir'),
  stat:       reject('stat'),
  readDir:    reject('readDir'),
  copyFile:   reject('copyFile'),
  moveFile:   reject('moveFile'),
  downloadFile: () => ({jobId: -1, promise: Promise.reject(new RnfsMockError('downloadFile'))}),
};
export default RNFS;
