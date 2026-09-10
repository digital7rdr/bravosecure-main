/**
 * F4 — is the conversation behind this notification a DEPARTMENT CHANNEL, and
 * which channel is it?
 *
 * WHY THIS EXISTS. A department channel's conversation is stored with
 * `type: 'group'`, exactly like an ordinary group. The msg-wake tap handler
 * therefore routed every one of them to `ChatScreen`, which renders phone and
 * video buttons unconditionally — breaking the PDF's locked A9/M9 rule:
 * "No phone/call button appears in Department Channel chat; calls remain in
 * Messenger." The conversation TYPE cannot tell the two apart, so the tap has to
 * ask what the store actually records about departmental conversations.
 *
 * THE TWO SIGNALS, and why both are read (this mirrors `isDepartmentConversation`
 * in ../vault/vaultOps.ts — same question, different consumer; keep them in step):
 *
 *   `deptConversationIds` — an ADDITIVE, persisted set of every conversation ever
 *      known to be departmental. `armDeptConversationRegistry()` fills it from the
 *      server channel list at messenger boot in ALL THREE shells, so it is the
 *      broadest and most reliably-populated "is this departmental" answer. It
 *      carries no channel id.
 *
 *   `deptGroupByChannel` — channelId -> conversationId POINTER, written when a
 *      channel thread is opened. B-206 OVERWRITES it on a channel remap, so it is
 *      pruned in practice and must never be the only source. It is, however, the
 *      only place the CHANNEL ID lives locally, and `DepartmentChatScreen` needs
 *      that id for every server call it makes.
 *
 * So a tap can land in three states, and each has its own destination:
 *   not departmental          -> Chat (unchanged)
 *   departmental + channel id -> DepartmentChat (the PDF's screen)
 *   departmental, id unknown  -> the DepartmentChannels directory
 *
 * The third is a DEGRADE, not a fallback to Chat: a channel the user has never
 * opened on this device has no pointer row, and opening it in ChatScreen would
 * put the banned call buttons on screen — the whole bug. One tap from the
 * directory reopens it with the full param set the screen wants.
 */

/** The two maps this decision reads. Structural so it can be fed either the live
 *  Zustand state or the persisted vault slice, which have identical shapes. */
export interface DeptRegistryMaps {
  deptConversationIds?: Record<string, true> | null;
  deptGroupByChannel?: Record<string, string> | null;
  /** vs2 edge A9 — conversationId -> owning org, when locally known. */
  deptOrgByConversation?: Record<string, string> | null;
}

export interface DeptConversationRoute {
  /** The department channel this conversation belongs to, when locally known. */
  channelId: string | null;
  /**
   * vs2 edge A9 — the WORKSPACE this thread lives in, when locally known.
   *
   * The wake itself cannot carry it: a dept-message push is
   * `{kind, conversationId, senderUserId}` and messenger-service holds no org
   * membership data at all. So the tap opened the thread by `channelId` (which
   * works) and Back landed in a directory belt-filtered by
   * `scopeChannelsToActiveWorkspace` to the STICKY org — one that does not
   * contain the thread just read. Null = unknown, which is exactly today's
   * behaviour.
   */
  orgId: string | null;
}

/**
 * `null` when the conversation is NOT a department channel — the caller keeps
 * its ordinary Chat routing. Otherwise the (possibly unknown) channel id.
 */
export function resolveDeptConversation(
  conversationId: string,
  maps: DeptRegistryMaps | null | undefined,
): DeptConversationRoute | null {
  if (!conversationId || !maps) {return null;}
  // vs2 edge A9 — read from the ADDITIVE map, so it survives a pointer remap
  // (B-206) exactly like `deptConversationIds` does.
  const orgId = maps.deptOrgByConversation?.[conversationId] ?? null;
  // The POINTER first — it answers both questions at once when it has the row.
  for (const [channelId, convoId] of Object.entries(maps.deptGroupByChannel ?? {})) {
    if (convoId === conversationId) {return {channelId, orgId};}
  }
  // …then the additive registry, which knows THAT it is departmental but not
  // which channel. Never pruned, so it still answers for a conversation whose
  // pointer B-206 has since remapped.
  if (maps.deptConversationIds?.[conversationId]) {return {channelId: null, orgId}; }
  return null;
}
