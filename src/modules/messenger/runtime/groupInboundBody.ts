/**
 * B-25 — plaintext group inner-envelope body extraction (presentation only).
 *
 * A sender that does NOT hold the group master key ships the inner
 * GroupMessageEnvelope as PLAINTEXT JSON instead of a master-key AES-GCM
 * wrap (productionRuntime send path:
 *   `sealedBody = masterKey ? JSON.stringify(groupEncrypt(...)) : innerEnvelope`).
 * On the receive side `parseGroupMessage` rejects that plaintext as
 * `malformed` (Audit P0-G2 — it deliberately refuses to accept an
 * unencrypted `kind:'text'` body at the crypto layer), so the group-receive
 * handler falls through to its legacy plaintext path. That path set
 * `content: unwrapped.body` verbatim — which for a keyless send is the whole
 * JSON string `{"groupId":…,"kind":"text","clientMsgId":…,"body":"hi"}`, so
 * the chat bubble rendered raw JSON and leaked the internal groupId/clientMsgId.
 *
 * This helper recovers the human-readable text: when `body` is the JSON form
 * of THIS group's inner text envelope, return its `.body`; otherwise return
 * the value unchanged so genuine legacy plaintext (ops-console / server-created
 * mission groups, which ship a bare string body) renders exactly as before.
 *
 * It does NOT decrypt, accept, or weaken anything the crypto gate
 * (`parseGroupMessage`) already decided — the message was already going to
 * render on this path; this only stops it rendering as raw JSON.
 */
export function unwrapPlaintextGroupInnerBody(
  body: string,
  groupId: string,
): string {
  // Fast reject: only a JSON object literal could be an inner envelope.
  // A bare plaintext string ('ops brief at 14:00') — or an empty body —
  // skips JSON.parse (charCodeAt(0) on '' is NaN, which is not '{').
  if (body.charCodeAt(0) !== 0x7b /* '{' */) {return body;}
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed
        && typeof parsed === 'object'
        && parsed.kind === 'text'
        && parsed.groupId === groupId
        && typeof parsed.body === 'string') {
      return parsed.body;
    }
  } catch {
    // Not JSON — a genuine plaintext body from a legacy/ops sender.
  }
  return body;
}
