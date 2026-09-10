/**
 * 🛑 Biometric hygiene contract for the on-device face check (PDF p.6):
 * detection is local, the capture is ALWAYS deleted, and only scalar metadata
 * ever leaves the module.
 */
const mockDetect = jest.fn();
const mockDeleteAsync = jest.fn().mockResolvedValue(undefined);

jest.mock('@react-native-ml-kit/face-detection', () => ({__esModule: true, default: {detect: mockDetect}}), {virtual: true});
jest.mock('expo-file-system/legacy', () => ({deleteAsync: mockDeleteAsync}), {virtual: true});

import {runFaceCheck} from '../faceCheck';

const detect = mockDetect;
const deleteAsync = mockDeleteAsync;

describe('runFaceCheck', () => {
  beforeEach(() => {
    detect.mockReset();
    deleteAsync.mockClear();
  });

  it('one face in frame → face_ok with the face_detected bucket', async () => {
    detect.mockResolvedValueOnce([{frame: {}}]);
    const out = await runFaceCheck('file:///cache/x.jpg');
    expect(out.face_ok).toBe(true);
    expect(out.face_meta.confidenceBucket).toBe('face_detected');
  });

  it('no face → face_ok=false (no_face), NOT face_unavailable', async () => {
    detect.mockResolvedValueOnce([]);
    const out = await runFaceCheck('file:///cache/x.jpg');
    expect(out.face_ok).toBe(false);
    expect(out.face_unavailable).toBeUndefined();
    expect(out.face_meta.confidenceBucket).toBe('no_face');
  });

  it('multiple faces → face_ok=false (multiple_faces)', async () => {
    detect.mockResolvedValueOnce([{}, {}]);
    const out = await runFaceCheck('file:///cache/x.jpg');
    expect(out.face_ok).toBe(false);
    expect(out.face_meta.confidenceBucket).toBe('multiple_faces');
  });

  it('detector crash → face_unavailable (distinct camera_unavailable reason server-side)', async () => {
    detect.mockRejectedValueOnce(new Error('mlkit init failed'));
    const out = await runFaceCheck('file:///cache/x.jpg');
    expect(out.face_ok).toBe(false);
    expect(out.face_unavailable).toBe(true);
  });

  it('ALWAYS deletes the captured frame (pass, fail, and crash)', async () => {
    detect.mockResolvedValueOnce([{}]);
    await runFaceCheck('file:///cache/a.jpg');
    detect.mockRejectedValueOnce(new Error('x'));
    await runFaceCheck('file:///cache/b.jpg');
    expect(deleteAsync).toHaveBeenCalledWith('file:///cache/a.jpg', {idempotent: true});
    expect(deleteAsync).toHaveBeenCalledWith('file:///cache/b.jpg', {idempotent: true});
  });

  it('emits scalar-only face_meta (no arrays/objects that could smuggle biometrics)', async () => {
    detect.mockResolvedValueOnce([{frame: {x: 1}}]);
    const out = await runFaceCheck('file:///cache/x.jpg');
    for (const v of Object.values(out.face_meta)) {
      expect(['string', 'number', 'boolean']).toContain(typeof v);
    }
  });
});
