/**
 * Multi-select batch actions for the Files tab — pure decision/orchestration
 * layer, effects injected (repo pattern: resolveSwipeSettle,
 * resolveTileOpacityAction). The screen supplies the real vault / share /
 * store effects; tests drive these directly without mounting RN.
 */

export interface SelectableFile {
  id:             string;
  conversationId: string;
  name:           string;
  mimeType:       string;
  inVault:        boolean;
}

/** Toggle one id; returns null when the last selection is removed (exit selection mode). */
export function toggleSelected(sel: ReadonlySet<string>, id: string): Set<string> | null {
  const next = new Set(sel);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next.size === 0 ? null : next;
}

/**
 * Select-all over the visible rows. If every visible id is already selected
 * the tap means "deselect" — returns null (exit selection mode).
 */
export function selectAllVisible(sel: ReadonlySet<string>, visibleIds: readonly string[]): Set<string> | null {
  const allSelected = visibleIds.length > 0 && visibleIds.every(id => sel.has(id));
  if (allSelected) {return null;}
  return new Set([...sel, ...visibleIds]);
}

export interface BatchMoveOutcome {
  moved:          number;
  alreadyInVault: number;
  /** Names of files that individually failed (bad bytes / transfer_failed). */
  failed:         string[];
  /** Batch-fatal message (no_pin / mfa_unavailable / tier) — remaining files were skipped. */
  fatal:          string | null;
  /** WHICH batch-fatal fired — 'tier' routes to the upgrade prompt, not an alert (B-591). */
  fatalReason:    'no_pin' | 'mfa_unavailable' | 'tier' | null;
  /** User cancelled the MFA ceremony — remaining files were skipped silently. */
  cancelled:      boolean;
}

export type VaultMoveFn = (params: {
  sourceKey: string;
  name:      string;
  mimeType:  string;
  bytes:     Uint8Array;
  /** Phase 4 — provenance, so the vault can refuse a company file. */
  conversationId: string | null;
}) => Promise<{ok: true} | {ok: false; reason: string; message: string}>;

/**
 * Move every selected file into the vault, one MFA-gated `moveBytesToVault`
 * per file — the same per-file ceremony as VaultScreen's multi-pick upload
 * (Issue 21). The security pipeline is NOT altered here; this only decides
 * skip / continue / abort:
 *   - already-vaulted rows are skipped, not re-uploaded;
 *   - an explicit user cancel aborts the REST of the batch (unlike Issue 21's
 *     keep-prompting loop, which is hostile at N files);
 *   - no_pin / mfa_unavailable would fail every file identically → abort with
 *     one honest message instead of N alerts.
 */
export async function runBatchVaultMove<T extends SelectableFile>(
  files: readonly T[],
  deps: {
    resolveBytes: (f: T) => Promise<Uint8Array | null>;
    moveToVault:  VaultMoveFn;
  },
): Promise<BatchMoveOutcome> {
  const out: BatchMoveOutcome = {moved: 0, alreadyInVault: 0, failed: [], fatal: null, fatalReason: null, cancelled: false};
  for (const f of files) {
    if (f.inVault) {
      out.alreadyInVault += 1;
      continue;
    }
    let bytes: Uint8Array | null = null;
    try {
      bytes = await deps.resolveBytes(f);
    } catch {
      bytes = null;
    }
    if (!bytes) {
      out.failed.push(f.name);
      continue;
    }
    const res = await deps.moveToVault({
      sourceKey: `msg:${f.id}`,
      name:      f.name,
      mimeType:  f.mimeType || 'application/octet-stream',
      bytes,
      // Phase 4 — the batch lane is one of four ways a company file could have
      // been copied into the personal vault. Forwarding the row's own
      // conversation lets the vault refuse it; `company_file` then falls
      // through to the per-file `failed` bucket below, so the rest of a mixed
      // selection still moves rather than the whole batch aborting.
      conversationId: f.conversationId,
    });
    if (res.ok) {
      out.moved += 1;
    } else if (res.reason === 'cancelled') {
      out.cancelled = true;
      break;
    } else if (res.reason === 'no_pin' || res.reason === 'mfa_unavailable' || res.reason === 'tier') {
      // B-591 — 'tier' joins this docblock's own rule: a lapsed plan fails
      // every file identically, so N biometric ceremonies + N round-trips
      // ending in a name list is exactly what this branch exists to prevent.
      out.fatal = res.message;
      out.fatalReason = res.reason;
      break;
    } else {
      out.failed.push(f.name);
    }
  }
  return out;
}

/**
 * Share every selected file through the OS sheet, sequentially — expo-sharing
 * has no multi-file intent, so each file gets its own sheet. A resolution
 * failure (no uri / download error) is collected and reported; a share()
 * throw is also a per-file failure, never an abort (Android's chooser
 * resolves on dismiss, so a throw is a real error).
 */
export async function runBatchShare<T extends SelectableFile>(
  files: readonly T[],
  deps: {
    resolveUri: (f: T) => Promise<string | null>;
    share:      (uri: string, f: T) => Promise<void>;
  },
): Promise<{shared: number; failed: string[]}> {
  const out = {shared: 0, failed: [] as string[]};
  for (const f of files) {
    let uri: string | null = null;
    try {
      uri = await deps.resolveUri(f);
    } catch {
      uri = null;
    }
    if (!uri) {
      out.failed.push(f.name);
      continue;
    }
    try {
      await deps.share(uri, f);
      out.shared += 1;
    } catch {
      out.failed.push(f.name);
    }
  }
  return out;
}

/**
 * Delete every selected file — mirrors FileViewer's single-file semantics:
 * the vault index row (when one exists) AND the underlying chat message are
 * both removed. Returns the number of messages removed.
 */
export function runBatchDelete<T extends SelectableFile>(
  files: readonly T[],
  deps: {
    removeMessage:     (conversationId: string, messageId: string) => void;
    vaultObjectKeyFor: (f: T) => string | null;
    removeVaultRow:    (objectKey: string) => void;
  },
): number {
  let removed = 0;
  for (const f of files) {
    const vaultKey = deps.vaultObjectKeyFor(f);
    if (vaultKey) {deps.removeVaultRow(vaultKey);}
    deps.removeMessage(f.conversationId, f.id);
    removed += 1;
  }
  return removed;
}
