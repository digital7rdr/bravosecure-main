# Onboarding Copy — Ops Disclosure

**Audit reference:** Phase 4.7
**Scope:** mobile + ops console first-run prompts

These strings ship in client builds. Update both the file and the
corresponding string ids when the legal text changes.

## Mobile — Mission Group join screen

> **Heads up.** This mission has an ops handler in the group chat.
>
> Bravo Operations joins your mission group chat so we can dispatch
> support fast if anything escalates. Like any group member, ops can
> read and send messages here. The group is end-to-end encrypted —
> Bravo's servers never see plaintext.
>
> You'll see ops in the roster marked with a `★ OPS` badge. Your 1:1
> chats with your CPO are private and ops cannot read them.
>
> Read the full disclosure → `bravo.app/legal/ops-disclosure`

## Mobile — Booking confirmation

Append a paragraph above the "Create booking" CTA:

> By booking, you agree that a Bravo Operations handler will be a
> participant in your mission group chat. Your 1:1 chats with your
> CPOs are private.

## Ops Console — First unlock of the messenger vault

> **Vault setup.** This browser will hold the keys that decrypt mission
> messages on your machine. Choose a vault passphrase OR enroll a
> passkey (Touch ID / Windows Hello / hardware key). Bravo can never
> recover this key — losing it means re-syncing your sessions and
> losing message history.

## Ops Console — MissionGroupPanel banner (already in code)

> ★ OPS — this thread is end-to-end encrypted, and the ops handler (you)
> is a participant. Every CPO and customer in the roster can see the
> ★ badge on your name.

(Rendered in `apps/ops-console/src/components/messenger/MissionGroupPanel.tsx`.)
