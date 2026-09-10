/**
 * B-391 — call audio never reaches a car hands-free kit (1:1 AND group).
 *
 * ROOT CAUSE, traced into the installed library:
 *
 *   Both call screens clear InCallManager's internal "force speakerphone" flag
 *   before choosing a route, by calling `setForceSpeakerphoneOn(false)`. That
 *   reads like "don't force the speaker". It is not what the library does:
 *
 *     index.js:66-69
 *       let flag = (typeof _flag === "boolean") ? (_flag) ? 1 : -1 : 0;
 *
 *     InCallManagerModule.java:884-893
 *       forceSpeakerOn = flag;                       // the flag IS cleared either way
 *       if      (flag ==  1) selectAudioDevice(SPEAKER_PHONE);
 *       else if (flag == -1) selectAudioDevice(EARPIECE);   // <-- boolean false lands HERE
 *       else                 selectAudioDevice(NONE);       // "NONE will follow default route"
 *
 *     InCallManagerModule.java:1642
 *       userSelectedAudioDevice = device;            // STICKY for the session
 *
 *   So `false` does not clear anything — it pins the EARPIECE as an explicit
 *   user choice. And that pin is checked first when the library decides where
 *   audio should go:
 *
 *     InCallManagerModule.java:1879-1885
 *       if (userSelectedAudioDevice != null && userSelectedAudioDevice != NONE)
 *            newAudioDevice = userSelectedAudioDevice;      // <-- EARPIECE wins
 *       else if (audioDevices.contains(BLUETOOTH))
 *            newAudioDevice = BLUETOOTH;                    // <-- never reached
 *
 *     InCallManagerModule.java:1813-1817
 *       if (... newAudioDevice == BLUETOOTH && bt.getState() == HEADSET_AVAILABLE)
 *            bluetoothManager.startScoAudio();              // <-- therefore never runs
 *
 *   `startScoAudio()` is the only thing that calls `startBluetoothSco()` /
 *   `setCommunicationDevice(TYPE_BLUETOOTH_SCO)`. No SCO link is ever requested,
 *   so the car head unit — which carries call audio over HFP only — is never
 *   given the call.
 *
 * WHY A CAR AND NOT EARBUDS: the earpiece pin is installed by the B-309 opening
 * settle as soon as the FIRST device list arrives, which `InCallManager.start()`
 * emits synchronously — before the BluetoothProfile.HEADSET proxy has connected.
 * This repo already measured that gap at ~870 ms (sqa.md B-297). A car kit is
 * slower to enumerate than earbuds, so it reliably loses that race, and once the
 * pin is in place the later discovery cannot matter.
 *
 * THE FIX is per-route, not a blanket change:
 *   SPEAKER_PHONE → true   pin the speaker (unchanged)
 *   EARPIECE      → false  pin the earpiece — that IS how "speaker off" is said
 *   BLUETOOTH     → 0      CLEAR the pin, then chooseAudioRoute selects the
 *   WIRED_HEADSET → 0      headset; if it is rejected because the device is not
 *                          enumerated yet, the library's own auto-Bluetooth
 *                          branch can still take it when the car appears.
 *
 * `forceSpeakerOn = flag` runs BEFORE the branch, so 0 still clears the internal
 * flag that `InCallManager.start({media:'video'})` sets — the B-276 echo fix is
 * preserved. That was the only reason these calls existed.
 */
import type {AudioRoute} from './callAudioRoute';

/**
 * The value to hand `InCallManager.setForceSpeakerphoneOn` for a target route.
 *
 * Returns `true` / `false` / `0` deliberately: `0` is NOT a boolean, and the
 * library branches on `typeof flag === 'boolean'`. Passing `false` where `0` is
 * meant is the entire bug, so this returns the value rather than calling the
 * native module — that keeps it unit-testable and gives both screens one shared
 * answer instead of a seventh hand-copy.
 */
/**
 * "Clear the pin entirely" — no route in mind, just release the force flag.
 *
 * The same 0  returns for a headset route, named so a
 * teardown site does not have to hand-write  and
 * silently become a second definition of the rule. index.js branches on
 * , so anything non-boolean means NONE.
 */
export const FORCE_SPEAKER_CLEAR: 0 = 0;

export function forceSpeakerFlagFor(route: AudioRoute): boolean | 0 {
  if (route === 'SPEAKER_PHONE') {return true;}
  if (route === 'EARPIECE') {return false;}
  // BLUETOOTH / WIRED_HEADSET — clear the pin instead of pinning the earpiece.
  return 0;
}
