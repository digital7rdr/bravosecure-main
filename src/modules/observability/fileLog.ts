/**
 * Group-call diagnostic file logger (opt-in, build-flagged).
 *
 * Why this exists: React Native RELEASE builds do not forward JS
 * `console.log` to logcat, and the project's release APK is the only
 * faithful repro of the group-call join failure (a debug build changes
 * timing + __DEV__ branches). Crashlytics breadcrumbs only surface on a
 * crash. So there is no way to read the joiner's `[group-create:recv]` /
 * `[bravo.groupcall.boot]` trace from a field device — which is exactly
 * why the group-call key-distribution bug has been diagnosed from
 * server+host logs only (and mis-fixed once).
 *
 * When `EXPO_PUBLIC_GROUPCALL_FILELOG === '1'` this installs a thin
 * mirror over console.log/warn/error that appends the call/group-key
 * subsystem lines (and ONLY those) to a file in the app's external
 * files dir, which `adb pull` can read with no root:
 *   /sdcard/Android/data/com.bravosecure.app/files/groupcall-trace.log
 *
 * Security: this is a diagnostic build flag (OFF by default, never set
 * in prod release commands). It mirrors only the call/key prefixes —
 * never arbitrary app logs — and runs the same redaction shapes as the
 * crashlytics wrapper so no key material / JWT can land on disk. The
 * instrumented lines already log fingerprints + truncated ids, not raw
 * keys, so redaction is a backstop.
 */

import {Platform} from 'react-native';
import RNFS from 'react-native-fs';

const ENABLED = process.env.EXPO_PUBLIC_GROUPCALL_FILELOG === '1';

// B-123 — ExternalDirectoryPath is Android-only; on iOS it is undefined, so
// every append silently no-ops and the whole trace is unavailable exactly
// where it was needed most (the iOS group-call bugs were being diagnosed from
// the ANDROID peer's logs). DocumentDirectoryPath is the iOS equivalent and is
// reachable from a Mac with:
//   xcrun devicectl device copy from --device <udid> \
//     --domain-type appDataContainer --domain-identifier com.bravosecure.mobile \
//     --source Documents/groupcall-trace.log --destination ./trace.log
const LOG_DIR = Platform.OS === 'ios'
  ? RNFS.DocumentDirectoryPath
  : RNFS.ExternalDirectoryPath;

const LOG_PATH = `${LOG_DIR}/groupcall-trace.log`;

// Mirror the messaging / call subsystem diagnostic lines so the WHOLE
// receive path is traceable: envelope arrival (drainRelay/pullEnvelopes)
// → decrypt/branch (recv.*) → group-create:recv / call-adhoc-key → the
// group-call boot (bravo.groupcall.*). These tags never log plaintext
// bodies (enforced by logAudit.test); redact() below is the backstop
// for any stray key/JWT. UI/unrelated logs are left alone.
const PREFIX_RE = /\[(bravo\.|group|call-adhoc|recv\.|recv:|messenger|ops-room|send\.|productionRuntime|sfu)/i;

// Same redaction shapes as observability/crashlytics — last line of
// defense against writing key material to disk.
const REDACT: Array<[RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jwt>'],
  [/-----BEGIN [^-]+-----[\s\S]+?-----END [^-]+-----/g, '<pem>'],
  [/[A-Fa-f0-9]{40,}/g, '<hex>'],
  [/[A-Za-z0-9+/]{43}=/g, '<b64-32>'],
];

function redact(input: string): string {
  let out = input;
  for (const [re, sub] of REDACT) {
    out = out.replace(re, sub);
  }
  return out;
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') {return a;}
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

// Serialize appends so concurrent calls don't interleave / race on the
// file handle. Errors are swallowed — logging must never break a call.
let chain: Promise<void> = Promise.resolve();
function append(line: string): void {
  chain = chain
    .then(() => RNFS.appendFile(LOG_PATH, line, 'utf8'))
    .catch(() => {
      /* best-effort diagnostic — never throw */
    });
}

/**
 * Mirror a single already-joined log line to the trace file if it matches
 * the messaging/call subsystem filter. Used by the console mirror AND by
 * the crashlytics wrapper (the deliver-path decrypt-failure reasons go
 * through crashLog, not console, so they'd otherwise be invisible). No-op
 * unless the build flag is set.
 */
export function mirrorToFile(level: string, joined: string): void {
  if (!ENABLED) {return;}
  try {
    if (PREFIX_RE.test(joined)) {
      append(`${new Date().toISOString()} ${level} ${redact(joined)}\n`);
    }
  } catch {
    /* never break logging */
  }
}

let installed = false;

/**
 * Install the console mirror. Idempotent + no-op unless the build flag
 * is set. Call as early as possible in the app entry so no call/key log
 * is missed.
 */
export function installGroupCallFileLog(): void {
  if (!ENABLED || installed) {return;}
  installed = true;

  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const mirror = (level: string, passthrough: (...a: unknown[]) => void) =>
    (...args: unknown[]): void => {
      try {
        const joined = fmt(args);
        if (PREFIX_RE.test(joined)) {
          append(`${new Date().toISOString()} ${level} ${redact(joined)}\n`);
        }
      } catch {
        /* never break logging */
      }
      passthrough(...args);
    };

  console.log = mirror('LOG', orig.log);
  console.warn = mirror('WARN', orig.warn);
  console.error = mirror('ERROR', orig.error);

  // Boot marker — confirms a capture came from the instrumented build
  // and that the mirror installed before the call subsystem ran.
  append(`${new Date().toISOString()} BOOT groupcall-filelog installed path=${LOG_PATH}\n`);
}

/** Absolute on-device path of the trace file (for tooling / docs). */
export const GROUPCALL_TRACE_PATH = LOG_PATH;
