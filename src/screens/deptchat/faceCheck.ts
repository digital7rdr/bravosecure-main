/**
 * On-device face confirmation for attendance (PDF p.6 "Look at the camera").
 *
 * 🛑 Biometric stop-conditions (architecture-signed 2026-07-02):
 *  - The captured frame NEVER leaves the device: detection runs locally (MLKit)
 *    and the temp file is deleted immediately after, pass or fail.
 *  - Only a boolean result + scalar audit metadata cross the wire (the server's
 *    sanitizeFaceMeta drops anything non-scalar as defence-in-depth).
 *  - No frame, URI, face geometry, or descriptor is ever logged or persisted.
 *  - This is face PRESENCE detection (a live face is in frame), NOT 1:1 identity
 *    matching — an identity matcher remains out of scope without separate
 *    architecture/legal sign-off.
 *
 * Degrades gracefully: if the MLKit native module isn't in this build, the
 * capture step still ran (camera preview + photo), so we fall back to
 * capture-presence mode rather than blocking check-in.
 */

export interface FaceCheckResult {
  face_ok: boolean;
  face_unavailable?: boolean;
  // Scalars only — mirrors the server's sanitizeFaceMeta contract.
  face_meta: Record<string, string | number | boolean>;
}

interface MlkitFace {
  frame?: unknown;
}
interface MlkitDetector {
  detect(imagePath: string, options?: Record<string, unknown>): Promise<MlkitFace[]>;
}

function loadDetector(): MlkitDetector | null {
  try {
    // Optional native dep — absent in builds that haven't rebuilt the APK yet.
    const mod = require('@react-native-ml-kit/face-detection');
    return (mod?.default ?? mod) as MlkitDetector;
  } catch {
    return null;
  }
}

async function deleteCapture(uri: string): Promise<void> {
  try {
    const fs = require('expo-file-system/legacy');
    await fs.deleteAsync(uri, {idempotent: true});
  } catch {
    // Best effort — the file lives in the app cache, which the OS purges.
  }
}

export async function runFaceCheck(photoUri: string): Promise<FaceCheckResult> {
  const detector = loadDetector();
  try {
    if (!detector) {
      // Capture-presence mode: the user did face the camera and a frame was
      // taken, but this build can't run detection — still a step above the v1
      // permission-only check; the bucket makes the difference auditable.
      return {
        face_ok: true,
        face_meta: {model: 'presence-capture', version: 'v2', confidenceBucket: 'capture_only'},
      };
    }
    const faces = await detector.detect(photoUri, {
      performanceMode: 'accurate',
      landmarkMode: 'none',
      contourMode: 'none',
      classificationMode: 'none',
    });
    const count = Array.isArray(faces) ? faces.length : 0;
    const bucket = count === 1 ? 'face_detected' : count === 0 ? 'no_face' : 'multiple_faces';
    return {
      face_ok: count === 1,
      face_meta: {model: 'mlkit-face', version: 'v1', confidenceBucket: bucket, faceCount: count},
    };
  } catch {
    // Detector present but failed to run → distinct camera_unavailable reason
    // server-side (never a silent pass, never a fake mismatch).
    return {
      face_ok: false,
      face_unavailable: true,
      face_meta: {model: 'mlkit-face', version: 'v1', confidenceBucket: 'detector_error'},
    };
  } finally {
    void deleteCapture(photoUri);
  }
}
