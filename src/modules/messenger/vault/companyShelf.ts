import type {LocalMessage} from '../store/types';

/**
 * Scope v2 Phase 4 — the COMPANY shelf of the Enterprise Vault (A10 / M11B).
 *
 * ── WHY THIS IS A VIEW, NOT A SECOND STORE ──────────────────────────────────
 *
 * The personal Vault is device-local: `VaultFile` — including `keyB64`, the
 * per-file AES-256 key — lives in AsyncStorage, and the server's entire
 * access-control model is the object-key prefix `vault/<callerUserId>/<uuid>`
 * (the L15 IDOR fix). Adding "company files shared across an org" to THAT store
 * would mean sharing per-file keys between users and relaxing
 * `createDownloadUrl` to presign another user's object — both named in
 * CLAUDE.md's stop conditions, and the second re-opens the IDOR the prefix
 * check exists to close.
 *
 * None of that is needed, because the mechanism already exists. A channel
 * attachment is an ordinary message: `media_object_key` / `media_key` /
 * `media_iv` travel INSIDE the sealed envelope, so every member of a
 * department channel already holds the key to every file posted in it,
 * distributed by the existing group-key machinery. The PDF says company-file
 * permissions are "inherited from the channel/incident the file belongs to" —
 * a description of exactly this.
 *
 * ── HOW THE SCOPE IS ENFORCED ───────────────────────────────────────────────
 *
 * STRUCTURALLY, in two independent layers, neither of which is a filter that
 * can be forgotten:
 *
 *   1. This function iterates the caller's CHANNEL LIST — the server's
 *      membership-scoped `listChannels` result — and follows each channel to
 *      its conversation. It never walks `messages` or `conversations` looking
 *      for department-shaped rows, so a conversation the user is not a member
 *      of has no path into the output at all.
 *   2. Even given a leaked object key, the bytes are AES-encrypted with a key
 *      that only travels inside a group-encrypted envelope. A non-member holds
 *      no such envelope.
 *
 * "Personal files and company files, never mixed" rests on three things, stated
 * precisely because an earlier version of this comment overclaimed:
 *
 *   - this module returns ONLY company files and never reads the personal vault
 *     store, and that store knows nothing about channels — so the two lists are
 *     built from disjoint inputs and are never concatenated;
 *   - `moveBytesToVault` REFUSES a file whose conversation is a department
 *     channel, so the copy path is closed at the single writer rather than at
 *     each button (four surfaces offered one; the first fix covered one);
 *   - `FileViewer` derives that same fact from the file and drops its vault
 *     actions for every caller.
 *
 * What is NOT claimed: `CompanyFile` is structurally assignable to `VaultFile`
 * (it has every required property), so merging the two arrays would compile.
 * The guarantee is the disjoint inputs and the choke point, not the type
 * system. And FORWARDING a company file into a DM makes a legitimately personal
 * copy the choke point cannot distinguish — a limit of the design, not a bug in
 * it.
 */

/** A file that lives in the company shelf. Deliberately NOT `VaultFile`: the
 *  two shelves must not become assignable to each other, because that is the
 *  only way they could end up in one list by accident. */
export interface CompanyFile {
  /** R2 object key from the message. Not an auth token — decryption still
   *  needs the per-file key below, which came from the sealed envelope. */
  objectKey: string;
  keyB64: string;
  ivB64: string;
  name: string;
  size: number;
  mimeType: string;
  createdAt: number;
  /** Provenance, so the UI can say which channel a file came from — and so a
   *  reviewer can see that every row is attributable to a membership. */
  channelId: string;
  channelName: string;
  messageId: string;
  /** The conversation the file was posted in — carried so the viewer can hand
   *  it to the vault refusal, rather than the shelf being the only guard. */
  conversationId: string;
}

/** The membership-scoped channel list this shelf is derived FROM. Matches the
 *  shape `departmentApi.listChannels` returns; kept structural so this module
 *  does not depend on the DTO. */
export interface ShelfChannel {
  id: string;
  name: string;
  group_conversation_id?: string | null;
}

export interface CompanyShelfInput {
  /** Server-filtered: the channels this user is actually a member of. */
  channels: ShelfChannel[];
  /** channelId → conversationId, as learned when a channel is provisioned. */
  deptGroupByChannel: Record<string, string>;
  messages: Record<string, LocalMessage[]>;
}

/** A message carries a usable attachment only when ALL THREE of key, iv and
 *  object key are present — anything less is ciphertext nobody can open, and
 *  listing it would be a broken row rather than a file. */
function usableAttachment(m: LocalMessage): boolean {
  return !!m.media_object_key && !!m.media_key && !!m.media_iv;
}

function displayName(m: LocalMessage): string {
  const named = m.media_meta?.name?.trim();
  if (named) {return named;}
  // Fall back to something honest rather than the object key, which is opaque
  // and would leak storage layout into the UI.
  const ext = (m.media_mime ?? '').split('/')[1];
  return ext ? `Attachment.${ext}` : 'Attachment';
}

/**
 * Every company file the caller can legitimately open **within the store's
 * hydration window**, newest first.
 *
 * That qualifier is load-bearing, not throat-clearing: boot loads
 * `MAX_HYDRATE_PER_CONVO` (200) messages per conversation and this is a view
 * over `messages`, so a file posted further back than that is not in the input
 * and cannot appear. The personal shelf is a durable index; this one is not.
 * (The window itself is a recorded deferral — the honest fix is a SQLCipher
 * query over `media_object_key`, which is a store-layer change.)
 *
 * Pure: no store reads, no network, no side effects — so the scope rule is
 * testable by construction rather than by mocking a screen.
 */
export function listCompanyFiles(input: CompanyShelfInput): CompanyFile[] {
  const out: CompanyFile[] = [];
  const seen = new Set<string>();

  // ITERATE THE MEMBERSHIP LIST. This is the scope. Walking `messages` and
  // filtering for department conversations would produce the same rows today
  // and silently widen the moment a non-member conversation looked departmental
  // — which is precisely the failure mode this phase was warned about.
  for (const ch of input.channels ?? []) {
    const convoId = ch.group_conversation_id ?? input.deptGroupByChannel?.[ch.id];
    if (!convoId) {continue;}
    for (const m of input.messages?.[convoId] ?? []) {
      if (!usableAttachment(m)) {continue;}
      // One row per object key: the same file re-shared into a second channel
      // is still one file, and a duplicate would let the count disagree with
      // the list.
      const key = m.media_object_key as string;
      if (seen.has(key)) {continue;}
      seen.add(key);
      out.push({
        objectKey: key,
        keyB64: m.media_key as string,
        ivB64: m.media_iv as string,
        name: displayName(m),
        size: m.media_meta?.sizeBytes ?? 0,
        mimeType: m.media_mime ?? 'application/octet-stream',
        createdAt: Date.parse(m.created_at) || 0,
        channelId: ch.id,
        channelName: ch.name,
        messageId: m.id,
        conversationId: convoId,
      });
    }
  }

  return out.sort((a, b) => b.createdAt - a.createdAt);
}
