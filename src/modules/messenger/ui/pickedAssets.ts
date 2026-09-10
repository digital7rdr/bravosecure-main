/**
 * B-87/MX-04 — pure normalisation for multi-photo picker results. Free
 * of React / react-native imports so the mapping + cap logic is
 * unit-testable (chatListLayout.ts convention).
 */

/** WhatsApp caps multi-select at 30; 10 keeps worst-case memory (10 × ≤50 MB reads, sequential) sane on mid-range devices. */
export const MAX_PICKED_ASSETS = 10;

export interface PickerAssetLike {
  uri?:      string;
  type?:     string;
  fileName?: string;
  width?:    number;
  height?:   number;
  /** react-native-image-picker reports seconds for library videos. */
  duration?: number;
}

export interface PickedAsset {
  uri:  string;
  mime: string;
  /** Library picks are image/video; camera, documents and voice notes construct PickedAssets directly. */
  kind: 'image' | 'video' | 'audio' | 'file';
  meta: {name?: string; width?: number; height?: number; durationMs?: number};
  /**
   * B-149 — the app CREATED this file (voice-note capture) and owns its
   * lifetime, so the sender deletes the plaintext once it is encrypted.
   * Never set for library/camera-roll picks: unlinking one of those would
   * delete the user's own photo out of their gallery.
   */
  ephemeralSource?: boolean;
  /**
   * B-707 — the pre-send caption typed in `MediaPreviewTray`. Rides on the
   * ASSET rather than a batch ref so it can never leak into the next batch:
   * `sendMedia` puts it in the message body, so a stray one would publish text
   * the user typed for a different photo. Only ever set on the first item of a
   * batch (`withBatchCaption`).
   */
  caption?: string;
}

/**
 * B-707 — stamp one pre-send caption onto a batch.
 *
 * WhatsApp semantics: a multi-pick carries ONE caption and it lands on the
 * first photo of the batch (the same rule `enqueueMediaAssets` already applies
 * to a reply quote, B-450). Blank/whitespace-only captions are dropped so an
 * untouched field cannot turn a photo into a captioned "statement" — that also
 * keeps `groupAlbums` collapsing the batch into an album tile (imageAlbums.ts).
 */
export function withBatchCaption(assets: PickedAsset[], caption: string): PickedAsset[] {
  const text = caption.trim();
  if (!text || assets.length === 0) {return assets;}
  return assets.map((a, i) => (i === 0 ? {...a, caption: text} : a));
}

export function normalizePickedAssets(assets: ReadonlyArray<PickerAssetLike> | undefined): PickedAsset[] {
  if (!assets?.length) {return [];}
  const out: PickedAsset[] = [];
  for (const a of assets) {
    if (!a?.uri) {continue;}
    const mime = a.type ?? 'image/jpeg';
    out.push({
      uri:  a.uri,
      mime,
      kind: mime.startsWith('video/') ? 'video' : 'image',
      meta: {
        name:       a.fileName ?? undefined,
        width:      a.width,
        height:     a.height,
        durationMs: typeof a.duration === 'number' ? Math.round(a.duration * 1000) : undefined,
      },
    });
    if (out.length >= MAX_PICKED_ASSETS) {break;}
  }
  return out;
}
