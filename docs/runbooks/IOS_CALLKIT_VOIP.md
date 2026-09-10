# iOS CallKit + VoIP Push — Enablement Runbook

Turns on native iOS incoming-call UI (lock-screen ring, system accept/decline)
and background/killed-app call wake. Android was always active; this is the iOS
half that shipped as a flag-gated skeleton.

Status: **client wiring complete (2026-07-18), pending device 5s-contract test +
server env deploy.** Do not consider this done until §5 passes on a device.

## 0. What was already built vs added

**Already present (skeleton):** `callKitBridge.ts` (full CallKit impl, gated on
`IOS_RUNTIME_ENABLED`), `voipPush.ts` (full PushKit bootstrap, gated on
`RUNTIME_ENABLED`), server `apnsClient.ts` (token-based VoIP, `apns-push-type:
voip`, topic `<bundle>.voip`), server `POST /push/register-voip`, and
`react-native-callkeep` + `UIBackgroundModes: voip`.

**Added this change:**

- `react-native-voip-push-notification` (3.3.3) — the PushKit native module.
- `ios/BravoSecure/AppDelegate.swift` — PKPushRegistryDelegate: `voipRegistration()`
  at launch, `didUpdatePushCredentials` (token → JS), and `didReceiveIncomingPush`
  which reports to CallKit **natively** via `RNCallKeep.reportNewIncomingCall(...
fromPushKit: true ...)` so the 5s contract is met even on a cold launch before
  JS is up.
- `ios/BravoSecure/BravoSecure-Bridging-Header.h` — framework-style imports of
  the two ObjC managers (this target builds pods as static frameworks).
- `voipPush.ts` — `getPushKit()` adapts the real module API (`registerVoipToken`
  / `addEventListener` / `removeEventListener`) to the bootstrap's expected shape,
  plus a `didLoadWithEvents` cold-launch replay.

## 1. The Apple credential — already satisfied by the .p8

The old skeleton comments say an "Apple VoIP Services Certificate" is required.
**That approach is deprecated.** Modern VoIP push uses a token-based APNs auth
key (`.p8`), which the team already has: **Key ID `B9U74KX24U`**, team
`88X6H88A4R`. `apnsClient.ts` already speaks token-based VoIP. No separate cert.

The **same** `.p8` serves regular APNs (FCM/data) and VoIP push — one key, both.

## 2. Server env (messenger-service) — REQUIRED for delivery

The relay reads these (see `push.service.ts:1161`). Until set, iOS VoIP wakes are
skipped (logged `push.voip.ios-skip`). Deploy on the messenger-service host,
`.p8` stored **outside** the repo checkout:

```
APNS_VOIP_KEY_ID=B9U74KX24U
APNS_VOIP_TEAM_ID=88X6H88A4R
APNS_VOIP_BUNDLE_ID=com.bravosecure.mobile
APNS_VOIP_KEY_PATH=/home/ubuntu/bravo/AuthKey_B9U74KX24U.p8
APNS_VOIP_KEY_SHA256=eefcf29bda5a17f6e4541ddc1a0baec7990c2b0c9dc3ed3e044d5bbf80b06ba6
# Dev/TestFlight-sandbox device builds: APNS_VOIP_SANDBOX=1
# App Store / production: omit APNS_VOIP_SANDBOX (defaults to production host)
```

`APNS_VOIP_KEY_SHA256` pins the .p8 hash — the client refuses to sign with a
swapped key. Value above is the sha256 of `AuthKey_B9U74KX24U.p8`.

> **Sandbox vs production must match the build's `aps-environment`.** Dev/ad-hoc
> builds are `development` → `APNS_VOIP_SANDBOX=1`. App Store builds are
> `production` → omit it. Mismatch = silent non-delivery (`BadDeviceToken`).

## 3. The 5-second contract (why this is risky)

iOS 13+: every VoIP push MUST report a CallKit incoming call within ~5s or Apple
**revokes the VoIP entitlement — no warning, no appeal.** The native
`didReceiveIncomingPush` handler reports SYNCHRONOUSLY before any JS/await, so a
broken JS bridge can't cause a miss. JS then runs HMAC verification and calls
`reportEnded(callId, 'failed')` if the wake is forged (brief ring flash, far
better than revocation).

## 4. The two flags (flip together, LAST)

Both must be `true` and MUST flip together — a display-call without a token can't
fire; a token without a display-call = guaranteed revocation:

- `src/modules/messenger/push/callKitBridge.ts` → `IOS_RUNTIME_ENABLED`
- `src/modules/messenger/push/voipPush.ts` → `RUNTIME_ENABLED`

## 5. Device test BEFORE trusting production (mandatory)

1. Build + install the dev (development-signed) build on a real device.
2. Confirm the VoIP token registers: log shows `[voip-push] onRegister, len=…`
   then `[voip-push] wake key stored` (needs §2 server env for the wake key).
3. **Controlled 5s-contract test** without the prod server: send a well-formed
   VoIP push straight to the device token via the `.p8` (APNs sandbox,
   `apns-push-type: voip`, topic `com.bravosecure.mobile.voip`, payload
   `{kind,callId,callerName,callKind,nonce,exp,sig}`). Device must show the
   CallKit incoming screen within 5s — proves the native report fires.
4. Full matrix: lock-screen ring, accept → app foregrounds into the call,
   decline → peer sees ended, background→foreground answer, app-killed cold
   launch ring.

Only after 4 passes should the prod server be pointed at real devices, because a
broken native handler + a live server = entitlement revocation.

## 6. Survive prebuild

`ios/` is gitignored/generated. The AppDelegate PushKit block, the bridging-header
imports, and `UIBackgroundModes: voip` must be reapplied by a config plugin on any
`expo prebuild` (see the plugin added alongside this change), or re-hand-applied.
