# Departmental Chat — fake read-ticks + destructive "Reactivate" data loss

**Date:** 2026-07-23
**Status:** audit only — root causes identified, code NOT yet changed.
**Reported by:** owner, live device testing (agency/CPO account).
**Scope:** `src/screens/messenger/DepartmentChatScreen.tsx`, `src/screens/messenger/DepartmentChannelsScreen.tsx`,
`src/modules/messenger/orgWorkspace/provisionChannel.ts`.

**How to use this file:** each bug below has a Root cause (verified by reading the code, not guessed) and a
Fix plan (concrete, scoped). Do the ticks fix first — it's small, low-risk, and mechanical. The key-loss fix
needs one on-device confirmation step (§2.4) before writing code, because there are two plausible causes and
they need different fixes.

---

## 1. Bug: double-tick shown even though nobody delivered/read/saw the image

### Symptom (reported)

In Departmental Chat, an outgoing message (including one with an image attachment) shows a double check-mark
("seen by everyone") immediately, even when other members have not opened the app, have not received the
message, and have not viewed the image.

### Root cause — CONFIRMED

`DepartmentChatScreen.tsx:533`:

```tsx
{
  mine && <Icon name="check-all" size={13} color={OB.accent} />;
}
```

This renders the double-tick for **every message the current user sent**, unconditionally. It does not read
`msg.status` at all. There is no other tick-related code anywhere in this file (`grep -i "tick|status|check"`
turns up nothing else) — no `pending`/`single`/`double`/`failed` distinction, nothing.

### Why this is definitely wrong — compare to the real implementation

The rest of the app does NOT do this. There is a single shared rule, written specifically because two
surfaces disagreed and it produced this exact class of bug once already (B-131):

- `src/modules/messenger/runtime/messageTicks.ts` — `outgoingTick(msg)`. Pure function: `msg.status` →
  `'none' | 'pending' | 'single' | 'double' | 'double-read' | 'failed'`. Doc comment explicitly warns:
  _"neither [surface] gets to own the RULE... that split is what keeps them from drifting apart again."_
- `ChatScreen.tsx:2680` (`statusToIcon`) is the correct reference implementation:
  ```tsx
  switch (outgoingTick({status, sender_id: 'self'})) {
    case 'pending':
      return {name: 'progress-clock', color: Bravo.textMute};
    case 'single':
      return {name: 'check', color: Bravo.textMute};
    case 'double':
      return {name: 'check-all', color: Bravo.textMute};
    case 'double-read':
      return {name: 'check-all', color: Bravo.glow}; // only case that should pop
    case 'failed':
      return {name: 'alert-circle', color: Bravo.alert};
  }
  ```

**Answer to "are we using the current perfect one or the previous one": Departmental Chat was never migrated
to the shared rule at all.** It's not a regression from a recent change — it's a screen that predates (or was
never touched by) the B-131 consolidation and still has its old placeholder icon.

### Is the underlying data even correct? — CONFIRMED yes

Checked whether department-channel (group) messages actually get correct per-recipient status tracking, since
group "read" semantics are more complex than 1:1 (N recipients, not one). `messengerStore.ts:883`
(`recordReadReceipts`) already implements this correctly and is topology-aware:

```ts
const isGroup = isGroupConversation(s, conversationId);
const required = isGroup
  ? (convo?.participants ?? []).filter(u => u && u !== ownUid)
  : null;
...
const allRead = required
  ? required.every(u => m.receipts?.[u]?.status === 'read')   // WhatsApp rule: ALL others, not just one
  : true;
if (allRead && m.status !== 'read') { m.status = 'read'; ... }
```

So `msg.status` on a department-channel message is already computed correctly (per-recipient receipts,
"read" only once everyone has read). **The data is right; the screen just never looks at it.**

### Fix plan

1. Import `outgoingTick` (or reuse `ChatScreen.tsx`'s `statusToIcon` — consider extracting it to a shared
   location since it's now needed by 2 screens, e.g. `src/modules/messenger/runtime/tickIcon.ts`).
2. In `DepartmentChatScreen.tsx`, wherever the bubble currently reads `mine && <Icon name="check-all" .../>`,
   replace with the same status-driven mapping ChatScreen uses. Needs the message's real `status` field —
   confirm it's present on whatever local message shape this screen already has in scope (it should be,
   since it reads from the same `useMessengerStore` message list as every other surface).
3. **Test first (per this repo's rule):** write/extend a test that renders a department-chat bubble with
   `status: 'sent'` and asserts it does NOT show `check-all`, then with `status: 'read'` and asserts it does.
   This should fail red against the current code (proving the bug), then pass after the fix.
4. **Regression gate:** `npx jest --selectProjects messenger-crypto` must stay green (per CLAUDE.md's
   "Messenger regression gate" rule — this touches `src/screens/messenger/**`).
5. Low risk, no data-model change — this is a pure rendering fix.

---

## 2. Bug: logging out and back in as agency/CPO → "Reactivate the chat" → all previous messages lost

### Symptom (reported)

After signing out and back in on an agency/CPO account, opening a department channel prompts to "reactivate"
it, and doing so loses all prior message history in that channel.

### What "Reactivate" actually does — CONFIRMED, and it IS destructive by design

`DepartmentChannelsScreen.tsx:100-135` (`openChannel`):

```ts
const hasKey = !!groupConversationId &&
  !!useMessengerStore.getState().groups[groupConversationId]?.masterKeyB64;
...
} else if (groupConversationId && !hasKey && isOwner) {
  // ORPHANED: the owner's device has the channel's group id but lost its master
  // key (re-share is impossible — the owner IS the key source).
  Alert.alert('Reactivate channel?',
    'This channel lost its encryption key on this device. Reactivating creates a fresh
     encrypted group and re-keys its members. Earlier messages stay unreadable.',
    [{text: 'Cancel'}, {text: 'Reactivate', onPress: () => recoverChannel(c)}]);
```

`recoverChannel` → `provisionChannel.ts`'s `ensureChannelProvisioned` → `rt.createGroupChat(...)`: this mints
a **brand new** Signal group with a **brand new** master key and a **new** `group_conversation_id`. It is not
a resync or a repair — it is "throw away the old encrypted thread, start a new one." The dialog is honest
about this ("Earlier messages stay unreadable") but it is the ONLY option offered — there is no attempt to
recover the real key first.

### Why does the owner's key go missing after a normal logout/login at all?

This is the part that needs on-device confirmation before fixing (§2.4), but here's what's already verified:

**A plain sign-out does NOT wipe local data.** `authStore.ts:153-156`:

> `wipeAtRest` (default FALSE) — a plain "Sign out" now PRESERVES local history (the SQLCipher message DB +
> keychain key, scoped to the stable owner key)... Only an explicit "Remove account from this device" passes
> `{wipeAtRest:true}`.

The dashboard's "Log Out" button (and the new `AgentProfileScreen` one) call plain `signOut()` — no
`wipeAtRest`. So on the SAME device, SAME account, a normal logout→login should NOT lose the local SQLCipher
DB or its keychain-wrapped keys. If `masterKeyB64` is genuinely missing after that, one of two things is true:

**Hypothesis A — hydration race, not real loss.** `groups[id].masterKeyB64` lives in the in-memory
`useMessengerStore` Zustand state, which is empty on a fresh JS process (right after login) until it's
rehydrated from the persisted SQLCipher store. `openChannel`'s `hasKey` check reads the store **synchronously
at tap time**. If the department channels screen can be opened (or auto-focused) before that rehydration
finishes, `hasKey` reads `false` even though the real key is sitting on disk a moment away from loading. This
would reproduce **every time**, right after login, and explain why it looks like total, reliable data loss —
the real key was never actually gone, the screen just checked too early and then immediately destroyed it via
`recoverChannel`.

**Hypothesis B — owner-key scoping mismatch.** The keychain/SQLCipher key is "scoped to the stable owner key"
per the authStore comment (implies something like `email ?? phone ?? id`). If two logins for the "same"
account resolve to a different value for that scoping key (e.g. one login flow populates `email` and another
doesn't, or `id` differs across environments/reseeds), the second login would open a **different** keychain
namespace and genuinely find no key — this would look identical to Hypothesis A from the UI but has a
different fix (fix the scoping key, not the timing).

**One thing this rules out being "impossible by design":** group master keys for department channels ARE
included in this app's encrypted backup/mirror format —
`src/modules/messenger/backup/backupWireV3.ts` and `restoreMessages.ts` both handle group key material, not
just 1:1 sessions. So the architecture already intends for a group key to be recoverable via backup restore.
**But** `restoreAllMessages()` is only ever called from two screens — `BackupSetupScreen.tsx` and
`BackupRestoreScreen.tsx` (grep-verified, no other call site). It is **not** part of the normal login boot
sequence. So even in a scenario where backup restore genuinely would recover the key, `openChannel` has no
idea that option exists and jumps straight to the destructive reset without ever suggesting "try restoring
your backup first."

### 2.4 — What to check on-device BEFORE writing a fix

This determines which of Hypothesis A/B (or both) is real:

1. Reproduce: log in as the agency/CPO owner, confirm a department channel has messages and the "Reactivate"
   prompt does NOT appear. Log out (plain sign-out, not "remove account"). Log back in on the **same device**
   immediately and open the same channel. Does "Reactivate" fire?
2. If yes — add a temporary log line at `DepartmentChannelsScreen.tsx:103` printing
   `Object.keys(useMessengerStore.getState().groups)` and whether the messenger runtime's hydration-from-disk
   has completed yet at that exact moment. If the group list is empty/short right after login but fills in
   moments later, that's Hypothesis A (a race) — confirmed by ADB logcat timestamps.
3. If the group key is confirmed still absent well after hydration has had time to finish (e.g. wait 10s,
   back out and re-open the channel list, key still missing), that points to Hypothesis B — compare the
   "stable owner key" value logged at signOut vs the one resolved at the next login (email/phone/id) to find
   the mismatch.
4. Also check: does this reproduce on a genuinely fresh install (uninstall/reinstall), where SQLCipher IS
   wiped by the OS? That case is **expected** to need backup restore — it is not a bug, but the UX gap (never
   offering backup restore before "Reactivate") still applies there too.

### Fix plan (once §2.4 confirms which hypothesis)

- **If Hypothesis A (race):** gate `openChannel`'s `hasKey` check on the messenger runtime's boot/hydration
  promise actually having resolved — do not evaluate `hasKey` (and never offer "Reactivate") until hydration
  is known complete. This is a pure ordering fix, no data-model change.
- **If Hypothesis B (scoping mismatch):** fix whatever produces the "stable owner key" so the same account
  resolves to the same keychain/DB namespace on every login, regardless of which field the login response
  happened to populate that time. Higher risk — touches the general SQLCipher-key derivation used by every
  screen, not just department chat, so it needs the full messenger-crypto regression suite + a manual 1:1 and
  group send/receive smoke test per `CLAUDE.md`'s "Verify nearby flows" rule.
- **Either way — UX fix, independent of the root cause:** before offering the destructive "Reactivate" dialog,
  first check whether an encrypted backup exists for this account (`BackupSetupScreen`/`BackupRestoreScreen`'s
  detection logic) and offer "Restore from backup" as the non-destructive first option, with "Reactivate
  (starts a fresh thread, old messages unreadable)" as the explicit fallback only if no backup is available or
  restore fails. This turns an unconditional data-loss button into a last resort.
- **This is a message-pipeline-adjacent change** (group key state, `productionRuntime.ts`'s hydration/boot
  path) — per `CLAUDE.md`, read `docs/runbooks/MESSAGE_LOOP.md` before touching `productionRuntime.ts` itself,
  and re-run `npx jest --selectProjects messenger-crypto` **twice** (B-126: this suite flakes ~50%, one green
  run is not evidence).

---

## Summary for whoever picks this up

| #   | Bug                                               | Confidence                                                                            | Size                                                            | Do this first                                             |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | Fake double-tick, ignores real status             | **Confirmed, root cause found**                                                       | Small, isolated, low risk                                       | Yes — ship independently                                  |
| 2   | "Reactivate" destroys history after normal logout | Root cause **narrowed to 2 hypotheses**, needs 1 on-device check (§2.4) before coding | Medium — touches group-key hydration timing or keychain scoping | Do the §2.4 check first, then pick the matching fix above |

Both are real, both are in scope for a fix. Bug 1 needs no further investigation — it can be fixed directly
from this document. Bug 2 needs the on-device confirmation step in §2.4 before writing code, because the two
candidate causes have different, non-overlapping fixes and guessing wrong would waste a cycle (or worse, "fix"
the wrong thing and ship it as resolved when it isn't).
