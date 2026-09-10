# Architecture Documentation — Amendment #1 (SFrame on Group Calls)

**Date:** 2026-05-23
**Section amended:** Page 4 — Client Component: MessengerModule → WebRTC voice / video
**Status:** Awaiting client sign-off
**Author:** Bravo Secure engineering

---

## Original text (as signed off)

> WebRTC voice / video: PeerConnection established via the signalling service. ICE candidates exchanged over WebSocket. Media encrypted via DTLS-SRTP.

## Amended text (proposed)

> **WebRTC voice / video:** PeerConnection established via the signalling service. ICE candidates exchanged over WebSocket. Media is encrypted on the wire via DTLS-SRTP between each client and the SFU (mediasoup) on every hop.
>
> **For group calls (3+ participants routed via the SFU):** an additional frame-level encryption layer (SFrame, AES-256-GCM) is applied inside libwebrtc before SRTP. Each participant holds a per-participant AES-256 key derived on-device from the group master key (already distributed via pairwise Signal sessions per the group-messaging design); the SFU forwards SFrame-ciphertext inside SRTP-ciphertext without ever holding either key. Group master key rotation on member-add / member-remove triggers a frame-cryptor key rotation in the same epoch, so removed members cannot decrypt post-removal traffic.
>
> **For 1:1 calls (direct PeerConnection, no SFU):** DTLS-SRTP between the two peers is sufficient — no SFrame layer is applied because no untrusted intermediary holds keys.

---

## Why this amendment

The original text was correct for 1:1 calls but **insufficient for group calls**. In an SFU topology (mediasoup), DTLS-SRTP terminates at the server: the SFU decrypts each incoming SRTP stream and re-encrypts it for each outbound receiver. While in flight, media frames pass through SFU process memory in plaintext. This is a property of any SFU-based system — Google Meet, Microsoft Teams, and pre-2020 Zoom all share it.

Industry-leading secure messengers (Signal, WhatsApp, Wire) layer a second cipher — SFrame — on top of SRTP for group calls. The SFU sees only SFrame-ciphertext-inside-SRTP-ciphertext and cannot decrypt either layer.

The amendment brings Bravo Secure's group-call media security in line with Signal / WhatsApp.

---

## What changes operationally

|                                         | Before amendment                                                    | After amendment                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1:1 call                                | DTLS-SRTP between two peers                                         | DTLS-SRTP between two peers (unchanged)                                                                                                                  |
| Group call (3+)                         | DTLS-SRTP from each client to the SFU; SFU decrypts and re-encrypts | DTLS-SRTP from each client to the SFU **+ SFrame (AES-256-GCM, per-participant) applied to each frame before SRTP**; SFU only forwards opaque ciphertext |
| Server-side capability to decrypt media | Yes (DTLS terminates at SFU)                                        | No (SFU has no SFrame key)                                                                                                                               |
| Key material in SFU process memory      | SRTP master keys for each leg                                       | SRTP master keys for each leg (no SFrame keys)                                                                                                           |
| Lawful intercept on the server          | Plaintext available                                                 | Ciphertext only — would require client-side cooperation                                                                                                  |
| Member-removed media confidentiality    | n/a (server had keys)                                               | Post-removal traffic uses a new epoch; removed member's keys cannot decrypt new frames                                                                   |
| TURN relay impact                       | None                                                                | None                                                                                                                                                     |
| 1:1 ↔ group call switch                 | n/a                                                                 | Group epoch advances on switch; SFrame keys derived afresh                                                                                               |

---

## Compliance / posture impact

- **End-to-end encryption claim:** with this amendment Bravo Secure can accurately describe group calls as end-to-end encrypted. Without it, marketing must call group calls "transport-encrypted" or "encrypted in transit" only (per the Zoom 2020 precedent).
- **Government / law-enforcement requests:** the SFU cannot produce plaintext group-call audio/video for any past or future calls. Subpoenas hit clients, not the server.
- **Cloud provider risk:** AWS / GCP / Azure cannot read group-call media even with root on the SFU host.
- **Insider risk:** a malicious operator with SFU access cannot record group calls in usable form.

The DTLS-SRTP layer remains in place — the amendment is purely additive. A hypothetical bug in SFrame fails closed (no decryption, frame dropped) and never falls back to plaintext.

---

## Implementation summary (for the engineering audit trail)

- **Underlying library:** `io.getstream:stream-webrtc-android` replaces the default libwebrtc artifact in `react-native-webrtc 124.0.7` on Android. Stream's build exposes `org.webrtc.FrameCryptor` / `FrameCryptorFactory` / `FrameCryptorKeyProvider` (AES-256-GCM, ratcheting key schedule). This is the same library powering LiveKit / GetStream / Daily.co commercial SFU products.
- **JS layer:** thin native-module bridge (`frameCryptorTransport.ts`). The cipher itself never crosses the JS-native boundary — only keys do, on rekey events (~1 per minute at most).
- **Key source:** existing `useMessengerStore.groups[conversationId].masterKeyB64` + `epoch`, derived per-participant via HKDF-SHA256 on-device.
- **iOS:** deferred. When the `/ios` Xcode target lands, `stream-webrtc-ios` provides the mirror `RTCFrameCryptor` API.
- **No new network protocol** — keys ride the existing group master-key channel (pairwise Signal sessions).

---

## Sign-off

| Party                       | Name                       | Date           | Signature      |
| --------------------------- | -------------------------- | -------------- | -------------- |
| Bravo Secure (engineering)  | **\*\*\*\***\_**\*\*\*\*** | \***\*\_\*\*** | \***\*\_\*\*** |
| Client (architecture owner) | **\*\*\*\***\_**\*\*\*\*** | \***\*\_\*\*** | \***\*\_\*\*** |

Once signed, this amendment becomes part of the System Architecture Documentation contract and the SFrame implementation can ship.
