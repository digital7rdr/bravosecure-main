# Operations Handler Disclosure

**Effective date:** 2026-05-12
**Audit reference:** Phase 4.7 — Bravo Lite Audit Tracker
**Scope:** Mission group chat threads in the Bravo Messenger

This document is the customer-facing and CPO-facing disclosure that an
operations handler (a Bravo employee with the `OPS`, `SUPERVISOR`, or
`ADMIN` role) is a participant in your mission group chat. It is
incorporated by reference into the main privacy policy.

## What "mission group" means

When a booking transitions to `LIVE`, the dispatch flow creates a group
conversation that contains:

- The customer (booking owner)
- The assigned Close Protection Officers (CPOs)
- The on-shift operations handler

This group is created from the ops console at dispatch time. Bookings
that do not need an in-band ops handler (per dispatch policy) skip the
ops member; the group then contains only the customer + CPOs.

## End-to-end encryption is preserved

All messages, voice notes, files, presence, read receipts, and typing
indicators in the mission group are encrypted end-to-end with the
Signal Protocol (libsignal). The ops handler decrypts on their own
device with their own private keys — the same trust model as any other
group member. Bravo's relay servers store ciphertext only, with a
maximum dwell time of 30 days per the Signal protocol default.

Specifically:

- **Sender certificate** verification (Ed25519) authenticates each
  message back to the sender's identity bundle.
- **Sealed Sender v2** hides the sender's identity from the relay; only
  the recipient device sees who sent each envelope.
- The group is fanned out as N pairwise Signal sessions, one per
  recipient device. The relay sees N opaque ciphertexts, never one
  shared plaintext.
- The ops console's IndexedDB vault is encrypted at rest with either:
  (a) a PBKDF2-derived AES-GCM key from an operator passphrase, or
  (b) an AES-GCM key derived via the WebAuthn PRF extension from the
  operator's passkey (Touch ID, Windows Hello, or a hardware key). The
  key never leaves the operator's device.

## What ops can do

Ops sees the same content that any group member sees — message bodies,
attachments, voice calls. Ops is shown in the roster with a `★ OPS`
chip and an explicit banner above the messages so members can never
miss their presence. The same chip is visible to customers and CPOs on
mobile.

Ops can:

- Read all messages in the mission group, the same way any member can.
- Send messages to the group.
- Acknowledge SOS alerts originating from the mission.
- View tasks, locations, and team status surfaced in the ops console's
  mission detail page.

## What ops cannot do

- Read 1:1 customer ↔ CPO conversations. Ops is not a member of those
  threads. The relay holds the ciphertext; ops's keys can't decrypt it.
- Read messages from before they joined the group. Signal's
  forward-secrecy property guarantees this.
- Disable encryption, lower the protocol version, or downgrade to a
  plaintext fallback. The clients refuse any envelope that does not
  match the strict sealed-sender v2 shape.
- Issue messages on a member's behalf. Sender-cert verification
  prevents impersonation.

## Audit trail

Every ops read of a mission group is recorded in the `ops_audit` table
with: actor (ops handler's user id and call sign), action
(`conversation.read`), subject (the conversation id), and timestamp.
PII reveals in the ops console (click-to-unmask phone/email/address)
are also recorded with `action='pii.reveal'` and the field kind.

These records are retained for the audit retention period defined in
the main privacy policy.

## How to opt out

A customer who does not want ops as a participant in their mission
group should book a service tier that does not include an ops handler
(currently: any non-LIVE mission, or a future "self-dispatch" tier).
Once the booking is LIVE with an ops-included service, removing ops
from the group will break the mission and force a re-dispatch.

## Recoverability

The operator's vault key is derived locally and never escrowed. If an
operator loses both their passphrase and all enrolled authenticators,
their message history is unrecoverable by Bravo. New sessions can be
re-established from the operator's keys after a fresh login, but
historical message bodies are lost. This is by design and is the price
of end-to-end encryption with no key escrow.
