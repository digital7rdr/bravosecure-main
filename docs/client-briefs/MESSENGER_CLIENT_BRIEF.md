# Bravo Messenger — Client Feature Brief

_A plain-language summary of everything the messenger module does today._

---

## 🔐 Security & privacy

- **End-to-end encrypted messaging.** Every message is sealed on the sender's device and can only be opened by the recipient. Our servers never see the plain text.
- **Sealed sender.** The server can't tell who sent a message to whom — not even the delivery metadata reveals the pair.
- **Disappearing messages.** Pick a timer (30 seconds, 5 minutes, 1 hour, 24 hours) and the message auto-deletes from both devices and the server after its deadline.
- **Unsend / retract.** Take a message back even after the recipient is offline — the server drops it before delivery.
- **Block users.** A block hides both parties from each other in contact lookup and stops any messages from reaching you.
- **Privacy toggles.** Control who sees your "last seen" and whether you send read receipts.
- **Biometric unlock.** Fingerprint / face ID gates the app every time you open it. Optional biometric-only sign-in skips the password after your first login.
- **Verified contacts.** A green check badge on a peer's avatar confirms their identity is cryptographically verified.

---

## 💬 One-on-one chat

### Messages

- **Text, photos, files, voice notes** — all encrypted in transit and at rest.
- **Read receipts** — double-tick turns blue the moment the recipient reads.
- **Typing indicator** — three animated dots appear on the peer's screen while you're typing; auto-clears if you stop.
- **Message status** — single tick (sent), double tick (delivered), blue double tick (read).
- **Stacked bubble grouping** — several quick-fire messages from the same sender collapse visually into one block, matching the look of iMessage / WhatsApp.

### Reply, reactions, forward

- **Swipe right on any message** to quick-start a reply — the composer opens with a preview bar showing "Replying to X".
- **Tap the quote strip** on a reply to jump to the original message, which pulses blue briefly so you can see what's being referenced.
- **Reactions** — double-tap a bubble for a quick ❤️ or long-press for the full palette (❤️ 😂 👍 🔥 😮 😢). Reactions appear as small chips below the bubble with counts.
- **Forward** any message (text / photo / file) to another conversation via long-press → Forward → pick a recipient from the list.
- **Copy** a message to your clipboard.
- **Delete** from your own device (the peer keeps their copy).

### Media & rich content

- **Camera** — snap a photo directly from the attachment menu.
- **Photo gallery** — pick any image with a local preview.
- **Documents** — any file type; shows an icon + filename in the bubble.
- **Voice notes** — press-and-hold the mic button, speak, release to send. Live timer + animated bars while recording.
- **Link previews** — paste a URL and a small preview card appears with the page's title, description, and thumbnail.

### Chat screen details

- **Peer header** shows the name, DEV/USER label, verified shield, live online dot, and mono "last seen Xm ago" text.
- **E2E banner** above the chat: "Messages are end-to-end encrypted · Signal v2".
- **Connection banner** slides in under the header when the network drops ("Reconnecting…") and out when it's back.
- **Scroll-to-bottom floating button** appears when you scroll up; badged with a blue pill if new messages arrived while you were reading history.
- **"New messages since you scrolled up"** counter on the FAB, resets when you tap to jump down.
- **Day divider** — "TODAY · 4:27 PM" with hairlines on either side between messages from different days.
- **SHA fingerprint** on each incoming bubble — a 4-char code so you can confirm at a glance that a message hasn't been tampered with.

### Composer

- **Emoji picker** — tap the face icon for the full emoji keyboard.
- **Attach** — plus icon opens a sheet with Camera / Photo / Document options.
- **Ephemeral timer** — amber clock icon lets you pick a disappearing-message TTL for the next send.
- **Send ↔ Mic swap** — when the text box is empty, the send button turns into a mic for voice notes. Start typing and it swaps back to send.
- **Reply preview bar** — shows above the composer when you're replying; tap the × to cancel.

---

## 📇 Chat list (Messenger home)

- **Recent conversations** sorted by latest message, with the active chat row subtly tinted blue.
- **Avatar + verified check** on each row.
- **Live online dot** — green when the peer's currently connected.
- **Preview icons** — a small ↪ for replies, → for forwarded content, 🔒 for encrypted channels, 📷 for photos, 📎 for files.
- **Unread counter** — blue gradient pill on the right when you have unread messages; shows the count (99+ after a hundred).
- **Timestamp** in blue when there's something unread, muted grey otherwise.
- **Search bar** filters across names, phone numbers, and the most recent 30 messages per conversation.
- **Swipe actions** — swipe right on a row for Pin / Unpin, swipe left for Mute / Unmute + Delete. Actions reveal with a smooth scale + fade animation.
- **Muted conversations** show a small bell-off icon next to the name; muted rows suppress push notification badges.
- **Pinned conversations** float to the top of the list with a subtle pin icon.
- **Compose FAB** — blue gradient circle with a pen icon in the bottom-right launches a new chat.

---

## 🆕 New chat

- **Contact discovery** — the app reads your phone's address book (with permission) and shows which of your contacts are already on Bravo.
- **Shows their real name** (the one you saved them under) + phone number.
- **Tap a contact → instant end-to-end encrypted conversation** starts up.
- **Invite non-Bravo contacts** — offers a "not on Bravo yet" path so you can invite them via SMS/Share.
- **Permission denied state** — polite prompt with an "Open Settings" button if contacts were declined.
- **Dev mode** shows a seeded test peer list for local development.

---

## 📞 Voice & video calling

- **1-on-1 voice & video calls** — encrypted end-to-end via WebRTC with Signal-backed key exchange.
- **Call-connect / call-end haptics.**
- **Animated pulse rings** on the live call screen.
- **Mic mute, speaker toggle, camera flip, hang up.**
- **Missed-call VoIP push** — if the callee is offline, their phone rings via VoIP push so they get the call even while the app is closed.
- **TURN relay** — calls fall back to our TURN servers (Mumbai + London) when a direct peer-to-peer connection isn't possible.

---

## 👤 Profile & settings

- **Display name + bio + avatar** — edit from the Settings cog on the chat list.
- **Blocked users list** — see everyone you've blocked, tap to unblock.
- **Privacy**:
  - Show last seen (on/off)
  - Send read receipts (on/off)
- **App lock** with biometrics.
- **Account phone + email** (read-only on the settings screen).

---

## 👥 Groups _(foundational)_

- **Group conversations** with the same end-to-end encryption as 1-on-1.
- **Create group** by picking members from your contacts.
- **Admin roles** — the creator starts as admin, can add/remove members and rename the group.
- **Leave group** for members; deletion for admins.
- **Auto-promotion** — if the last admin leaves, the longest-standing member gets promoted automatically so the group never becomes orphaned.

> Phase 2 items in flight: group @mentions, group media gallery, member avatars, and advanced admin permissions.

---

## 🔔 Notifications

- **Push notifications** on new messages + calls.
- **VoIP push** for incoming calls, so the phone rings even if the app isn't open.
- **Silent pushes** for delivery receipts (no sound, no banner).
- **Per-conversation mute** — muted conversations don't trigger push or the unread badge.

---

## 🏠 Dashboard integration

The Bravo command dashboard (Home) surfaces messenger state alongside other modules:

- **Bravo Messenger tile** shows unread count at a glance.
- **Recent activity feed** mixes incoming messages with security events, bookings, and system alerts on a single timeline.
- **Tab bar** lets you switch between Home, Messenger, Secure (bookings / jobs), Intel (news feed), and Profile.

---

## ✨ Premium polish

- **Obsidian dark theme** with a cool platinum-cobalt accent — designed to feel secure and tactile.
- **Gradient backgrounds** + subtle noise grain for depth.
- **Glass-morphic cards** with 1px edge-light borders.
- **Typography pairing** — Inter Tight for display/body, JetBrains Mono for technical metadata (timestamps, fingerprints, status).
- **Haptic feedback** on send, reactions, swipe actions, and call events — confirms every interaction.
- **Smooth animations** on swipe reveals, bubble entry, typing dots, and message highlight pulses.
- **Connection-aware UI** — the chat header shows live state (connecting, reconnecting, unauthorized) without interrupting the user.

---

## 🌐 Reliability

- **Auto-reconnect** — the app keeps trying to restore the encrypted channel in the background. The user sees a slim "Reconnecting…" banner; no lost messages.
- **Offline-first** — messages you send while offline are queued and deliver automatically when you're back online.
- **Session persistence** — once you've signed in, the app keeps you logged in across restarts and app updates. No more "sign in every time the app launches."
- **Cross-device presence** — the system tracks multi-device users properly (you're "online" as long as any of your devices is connected).
