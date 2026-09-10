import {deriveEntitlements, type Entitlements} from '@store/entitlements';

/** The user shape `deriveEntitlements` accepts, mirrored so this module keeps a
 *  single import and no direct dependency on the auth store's own graph. */
type EntitledUser = Parameters<typeof deriveEntitlements>[0];

/**
 * B-661 — is the Channels surface offered to this user? Founder, 2026-08-25:
 * "the channel menu should not be accessible to lite version person."
 *
 * ── WHY THIS IS A PURE FUNCTION AND NOT A HOOK IN THE TAB BAR ────────────
 * The first attempt put a `useAuthStore` read inside `MessengerTabBar`, so the
 * rule would live in the one component both hosts share. That broke four
 * unrelated test suites: the bar is a presentational footer, and reaching into
 * the auth store gave it a transitive dependency on `expo-local-authentication`
 * and `@react-native-firebase/crashlytics` — untransformed ESM that kills any
 * suite whose import graph now reaches it. A footer that cannot render without
 * Crashlytics is the wrong shape, and mocking native modules per-suite to prop
 * it up would have been treating the symptom.
 *
 * So the RULE lives here, pure and dependency-light, and the hosts (which
 * already hold the user) call it. That is the same shape `secureRootRoute` uses
 * for the tier landing: one named place where the question is asked, several
 * callers. What must not drift is the ANSWER, not the number of call sites.
 *
 * ⚠️ UX GATE, NOT AN ACCESS BOUNDARY. Hiding the tab hides a door, not the
 * room. Workspace access is enforced server-side by org membership — a LITE
 * user with no workspace already gets an empty list, and the scoped surfaces
 * carry their own checks (manager_scope_root_ids, the enterprise-join refusal).
 * If Channels must be genuinely denied to a paying tier, that belongs in the
 * service, not here.
 *
 * Reads the MESSENGER entitlement, never the Secure plan: two different ladders
 * that merely share the lite/pro vocabulary (SP-01).
 */
/**
 * THE RULE, expressed once. Both entry points below funnel through this, so a
 * caller that already holds `Entitlements` (FilesScreen calls `useEntitlements`)
 * does not have to restate it — restating is exactly how two surfaces end up
 * disagreeing about who gets a door.
 *
 * Org-affiliated users keep Channels whatever their tier: a workspace is their
 * whole reason to be here.
 */
export function canSeeChannelsFor(ent: Entitlements): boolean {
  return ent.isEnterprise || ent.effective !== 'lite';
}

/** For a caller that holds the raw user (MessengerHome). */
export function canSeeChannels(user: EntitledUser): boolean {
  return canSeeChannelsFor(deriveEntitlements(user));
}
