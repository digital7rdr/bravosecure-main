/**
 * B-450 — you can reply to a TEXT message but not to a photo, voice note,
 * video or file, in a 1:1 or a group.
 *
 * There was never a predicate blocking media replies. The block was
 * STRUCTURAL: a media bubble mounts its own inner `TouchableOpacity`
 * (open-image / play / retry / album tile), which wins React Native's
 * responder negotiation, so the row wrapper's `onLongPress` — the ONLY thing
 * that opens the action sheet — never fired on media. A text bubble renders a
 * plain `<Text>`, which is exactly why replies worked there and only there.
 * Everything downstream already supported it (`previewForReply` returns
 * '📷 Photo' / '🎤 Voice message' / '🎬 Video' / '📎 Attachment', the wire
 * carries {messageId, preview}, the quote strip renders).
 *
 * The same commit closed the adjacent half: replying WITH an attachment
 * silently DROPPED the quote and left it armed, so it leaked onto the next
 * text message. `sendMedia` never read `replyTo`, and `sendText` skips its own
 * `appendMessage` when handed `existingMsgId` — so nothing stamped the
 * author's bubble either.
 *
 * Source scan, because all three files mount RN trees the node project cannot
 * build (`ChatScreen.tsx` alone is 4.5k lines) and no test imports
 * `productionRuntime.ts` at all.
 *
 * TRAPS this file is written around (each has cost this repo a session):
 *  - **CRLF.** These screens are CRLF; a `\n`-anchored regex matches nothing
 *    and the suite passes VACUOUSLY. Every read normalises first, and the
 *    "the scan reads real code" block below proves the normalisation ran.
 *  - **Prose.** Every rule here is also stated in a comment next to the code,
 *    so matching the prose would pass vacuously too. Everything reads
 *    COMMENT-STRIPPED source.
 *  - **Asserting a token exists "somewhere in the file".** `onLongPress`
 *    appears many times in these screens. Each assertion below is scoped to
 *    the ONE JSX opening tag that owns the decision.
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {previewForReply} from '../ui/chatScreenLogic';
import type {LocalMessage} from '../store/types';

const CHAT    = join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx');
const LINKTXT = join(process.cwd(), 'src', 'modules', 'messenger', 'ui', 'LinkifiedText.tsx');
const LINKCRD = join(process.cwd(), 'src', 'modules', 'messenger', 'ui', 'LinkPreviewCard.tsx');
const DEPT    = join(process.cwd(), 'src', 'screens', 'messenger', 'DepartmentChatScreen.tsx');
const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');
const IFACE   = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'runtime.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Comment-stripped, CRLF-normalised source — the only text any rule reads.
 *
 * LINE-BASED on purpose. The JSX-comment regex the older scans in this repo
 * use is not safe here: on `runtime.ts` it matched an opening brace near the
 * top of the file against a block-comment terminator hundreds of lines lower
 * and deleted the whole `MessengerRuntime` interface, so an assertion about
 * `sendMedia` failed with "not found" while the code was perfectly correct.
 * Same family as the CRLF trap — a scanner mis-reading real code is as
 * dangerous as one reading prose.
 */
function code(path: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of read(path).split('\n')) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('//') || t.startsWith('*')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

/**
 * The JSX OPENING TAG that contains `anchor` — from `<Tag` to the `>` that
 * ends its attribute list.
 *
 * Scoped rather than file-wide on purpose: `expect(src).toContain('onLongPress')`
 * would already pass on the broken tree, since the row wrapper has always had
 * one. The bug is precisely that the INNER element does not.
 *
 * Depth counting is safe here because an arrow's `>` only ever appears inside
 * an attribute expression's braces, i.e. never at depth 0.
 */
function openingTag(src: string, anchor: string, tag = 'TouchableOpacity'): string {
  const at = src.indexOf(anchor);
  expect(`${anchor} @ ${at >= 0}`).toBe(`${anchor} @ true`);
  // Unique anchor: a second occurrence means the scan may be pinning the
  // wrong element, which is how a source scan silently stops guarding.
  expect(src.indexOf(anchor, at + 1)).toBe(-1);
  const open = src.lastIndexOf(`<${tag}`, at);
  expect(open).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') {depth++;}
    else if (c === '}' || c === ')' || c === ']') {depth--;}
    else if (c === '>' && depth === 0 && i > open) {return src.slice(open, i + 1);}
  }
  throw new Error(`unterminated <${tag}> around "${anchor}"`);
}

/** `sendMedia`'s body, bounded by the next runtime method. */
function sendMediaBody(): string {
  const src = code(RUNTIME);
  const start = src.indexOf('sendMedia: async');
  const end   = src.indexOf('downloadMedia: async', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** ChatScreen's media-send helper, bounded by the serial queue that drives it. */
function sendPickedMediaBody(): string {
  const src = code(CHAT);
  const start = src.indexOf('const sendPickedMedia = useCallback');
  const end   = src.indexOf('const sendPickedMediaRef', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** ChatScreen's TEXT send, bounded by the retry helper that follows it. */
function sendTextBody(): string {
  const src = code(CHAT);
  const start = src.indexOf('const send = async (trimmed: string');
  const end   = src.indexOf('const retrySend = useCallback', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** The serial queue's entry point, bounded by the next declaration after it. */
function enqueueMediaAssetsBody(): string {
  const src = code(CHAT);
  const start = src.indexOf('const enqueueMediaAssets = useCallback');
  const end   = src.indexOf('const captureImage', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('the scan reads real code, not prose and not a vacuous empty match', () => {
  it.each([CHAT, DEPT, RUNTIME, IFACE, LINKTXT, LINKCRD])('%s is non-trivial and LF-normalised', path => {
    const src = code(path);
    expect(src.length).toBeGreaterThan(2_000);
    expect(src).not.toContain('\r');
  });

  it('the comment stripper really removed the prose that states these rules', () => {
    // The word appears in this commit's own comments in both screens; if the
    // stripper regressed, every assertion below could match a comment.
    expect(read(CHAT)).toContain('B-450');
    expect(code(CHAT)).not.toContain('B-450');
  });
});

describe('B-450 — every media touchable in ChatScreen arms the action sheet', () => {
  // Each of these is an inner TouchableOpacity that steals the responder from
  // the row wrapper. `onLongPress` is the wrapper's OWN handler threaded down,
  // so the sheet target and the haptic are identical to a text bubble's.

  it('the image bubble opens the sheet on long-press', () => {
    const el = openingTag(code(CHAT), '!imageBroken && attachment.uri && onOpenImage()');
    expect(el).toContain('onLongPress={onLongPress}');
  });

  it('the video / voice-note / DOCUMENT row opens the sheet on long-press', () => {
    const el = openingTag(code(CHAT), 'style={styles.fileAttachRow}');
    expect(el).toContain('onLongPress={onLongPress}');
  });

  it('...and that ONE row really is the document lane too, not just A/V', () => {
    // Founder scope: "any media like documents etc". A PDF / docx renders
    // through the SAME touchable as video and voice because the branch is
    // `isVideo || isAudio || isFileAtt` — so the fix above covers documents by
    // construction. Pinned because splitting this branch (a distinct document
    // card, say) would silently drop the long-press for documents alone, and
    // no screenshot of a video reply would ever reveal it.
    const c = code(CHAT);
    const at = c.indexOf('style={styles.fileAttachRow}');
    expect(at).toBeGreaterThan(-1);
    const branch = c.lastIndexOf(') : isVideo || isAudio || isFileAtt ? (', at);
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(at);
    // `isFileAtt` covers `msg.type === 'file'`, which is what the runtime
    // stamps for a document — and previewForReply already labels it.
    expect(c).toMatch(/const isFileAtt = msg\.type === 'file'/);
  });

  it('the broken-image "Tap to retry" affordance opens the sheet on long-press', () => {
    // The smallest of the four and the easiest to forget: a photo that failed
    // to decrypt is exactly the one a user wants to reply to / report.
    const el = openingTag(code(CHAT), 'onPress={attachment.load}');
    expect(el).toContain('onLongPress={onLongPress}');
  });

  it('the quote strip of a reply opens the sheet on long-press', () => {
    // Same nested-touchable class; without it, long-pressing the quote of a
    // reply jumped to the quoted message instead of opening the sheet.
    const el = openingTag(code(CHAT), 'style={[styles.replyStrip, sent && styles.replyStripSent]}');
    expect(el).toContain('onLongPress={onLongPress}');
  });

  it('every one of them uses the wrapper delay, so the gesture feels the same', () => {
    for (const anchor of [
      '!imageBroken && attachment.uri && onOpenImage()',
      'style={styles.fileAttachRow}',
      'onPress={attachment.load}',
      'style={[styles.replyStrip, sent && styles.replyStripSent]}',
      'style={[styles.albumTile, box]}',
    ]) {
      expect(openingTag(code(CHAT), anchor)).toContain('delayLongPress={280}');
    }
    // The preview card is the sixth long-press site. It lives in its own
    // component, so it takes the delay as a PROP rather than a literal — but
    // it must not be left on RN's 500ms default: a release in the 280-500ms
    // band then fires this element's onPress instead of the sheet, which opens
    // the URL on the card and, on the CONSENT CHIP, runs the T-12 privacy
    // fetch (a third-party host ping from the recipient's IP) off a gesture the
    // user aimed at the action sheet.
    const crd = code(LINKCRD);
    for (const anchor of ['style={styles.card}', 'style={styles.consentChip}']) {
      expect(openingTag(crd, anchor)).toContain('delayLongPress={delayLongPress}');
    }
    // A caller that forgets the prop still lands on ChatScreen's wrapper delay,
    // never on the 500ms dead band.
    expect(crd).toMatch(/delayLongPress = 280/);
    // Each screen passes ITS OWN wrapper delay: 280 in ChatScreen, 350 in the
    // dept channel (whose bubble Pressable and file card both use 350).
    expect(code(CHAT)).toContain('onLongPress={onLongPress} delayLongPress={280} />');
    const dept = code(DEPT);
    const deptCard = dept.slice(dept.indexOf('<LinkPreviewCard'), dept.indexOf('/>', dept.indexOf('<LinkPreviewCard')));
    expect(deptCard).toContain('delayLongPress={350}');
  });
});

describe('B-450 — LINKS: the two press responders inside a text bubble', () => {
  // Founder scope: "any media like documents etc, links etc". A message whose
  // body contains a URL mounts TWO extra responders inside the bubble — the
  // tappable URL span and the preview card — and each swallowed the long-press
  // exactly like a media touchable. On a link-only message the card is usually
  // the biggest target in the bubble, so this was the common case, not an edge.

  it('a URL span in LinkifiedText carries the bubble long-press', () => {
    const el = openingTag(code(LINKTXT), 'accessibilityRole="link"', 'Text');
    expect(el).toContain('onPress={() => { void Linking.openURL(seg.url!)');
    expect(el).toContain('onLongPress={onLongPress}');
  });

  it('the handler reaches BOTH LinkRun paths (mention-free body and mixed body)', () => {
    // segmentMentions splits a body with mentions into runs, each rendered by a
    // SECOND <LinkRun>. Wiring only the early return would leave every
    // mention-bearing message with a dead link long-press.
    const runs = code(LINKTXT).match(/<LinkRun[^>]*>/g) ?? [];
    expect(runs).toHaveLength(2);
    for (const r of runs) {expect(r).toContain('onLongPress={onLongPress}');}
  });

  it('the plain-text and mention spans are deliberately left alone', () => {
    // They register no press handler, so they never claimed the responder —
    // long-press on ordinary body text always worked. Adding a handler there
    // would be dead code, and the accessibility label is what a screen reader
    // reads, so it must not grow a second gesture.
    const c = code(LINKTXT);
    const at = c.indexOf('accessibilityLabel={`mention ');
    expect(at).toBeGreaterThan(-1);
    const mentionSpan = c.slice(c.lastIndexOf('<Text', at), at);
    expect(mentionSpan).not.toContain('onPress');
    expect(mentionSpan).not.toContain('onLongPress');
  });

  it('BOTH LinkPreviewCard branches carry it — the card and the consent chip', () => {
    // The consent chip is the RECEIVED-link state (T-12 privacy), i.e. the one
    // a recipient actually sees, and it is the one most likely to be forgotten.
    const c = code(LINKCRD);
    for (const anchor of ['style={styles.card}', 'style={styles.consentChip}']) {
      expect(openingTag(c, anchor)).toContain('onLongPress={onLongPress}');
    }
  });

  it('both screens pass it at every call site', () => {
    const chat = code(CHAT);
    // Body renderer, caption renderer, and the preview card.
    expect((chat.match(/<LinkifiedText/g) ?? [])).toHaveLength(2);
    for (const el of chat.match(/<LinkifiedText[\s\S]*?\/>/g) ?? []) {
      expect(el).toContain('onLongPress={onLongPress}');
    }
    expect(chat).toContain('<LinkPreviewCard text={msg.content} autoFetch={sent} onLongPress={onLongPress} delayLongPress={280} />');
    // Dept renders its own body spans (no LinkifiedText) but does mount the card.
    const dept = code(DEPT);
    const card = dept.slice(dept.indexOf('<LinkPreviewCard'), dept.indexOf('/>', dept.indexOf('<LinkPreviewCard')));
    expect(card).toMatch(/onLongPress=\{\(\) => \{ haptics\.impact\(\); setActionMsg\(m\); \}\}/);
  });
});

describe('B-450 — which message kinds can be quoted (the founder\'s list)', () => {
  const msg = (over: Partial<LocalMessage>): LocalMessage =>
    ({type: 'text', content: '', ...over} as LocalMessage);

  it('every user-content kind yields a non-empty quote', () => {
    // The affordance is only half the feature: a reply whose strip is blank
    // reads as broken. Per-kind labels are covered in chatScreenLogic.test.ts;
    // this is the B-450 roll-up so the founder's list is pinned as ONE rule.
    for (const type of ['image', 'video', 'audio', 'file'] as const) {
      expect(previewForReply(msg({type}))).not.toBe('');
    }
    expect(previewForReply(msg({content: 'see https://bravo.example/x now'})))
      .toContain('https://bravo.example/x');
  });

  it('system and call rows are deliberately NOT extended', () => {
    // They are not user content. Their preview falls through to `content`,
    // which is empty for a call record — quoting "" is worse than not offering
    // it, and the sheet is not reachable from a CallRecordRow at all (it is
    // rendered before MessageBubble, with only an onPress that re-dials).
    expect(previewForReply(msg({type: 'call'}))).toBe('');
    expect(code(CHAT)).toContain('<CallRecordRow');
    const c = code(CHAT);
    const row = c.slice(c.indexOf('<CallRecordRow'), c.indexOf('/>', c.indexOf('<CallRecordRow')));
    expect(row).not.toContain('onLongPress');
  });
});

describe('B-450 — an album tile targets the photo that was pressed', () => {
  // `chatListItems` collapses a photo burst to ONE leader row, so the row's own
  // onLongPress can only ever reach the leader. Replying to the 3rd photo of a
  // burst would have quoted the 1st.

  it('AlbumTileView arms a long-press of its own', () => {
    expect(openingTag(code(CHAT), 'style={[styles.albumTile, box]}'))
      .toContain('onLongPress={onLongPress}');
  });

  it('AlbumGrid hands back the TAPPED tile\'s message, not the leader', () => {
    const src  = code(CHAT);
    const at   = src.indexOf('function AlbumGrid');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n}', src.indexOf('</View>', at)));
    // Same message the tile's own onOpen targets — that identity is the whole
    // point, and it is why nothing new had to be plumbed into the tile.
    expect(body).toContain('const msg = album[tile.msgIndex];');
    expect(body).toContain('onOpen={() => onOpenPhoto(msg)}');
    expect(body).toContain('onLongPressPhoto(msg)');
    // A fallback to the leader would look right in every screenshot and quote
    // the wrong photo every time.
    expect(body).not.toMatch(/onLongPressPhoto\(album\[0\]\)/);
  });

  it('the bubble threads the per-photo handler into the grid', () => {
    expect(code(CHAT)).toContain('<AlbumGrid album={album} onOpenPhoto={onOpenPhoto} onLongPressPhoto={onLongPressPhoto} />');
  });

  it('the row supplies it from the SAME source as the wrapper long-press', () => {
    const src = code(CHAT);
    expect(src).toContain('onLongPressPhoto={longPressMessage}');
    expect(src).toContain('onLongPress={() => longPressMessage(msg)}');
  });

  it('"open the sheet for this message" is defined exactly ONCE', () => {
    // Duplicate-copy bug class: with six long-press sites, copying
    // `haptics.impact(); setActionMsg(m)` to each guarantees the copies drift
    // and only one carries a later change (a permission gate, say).
    const src = code(CHAT);
    expect(src.match(/setActionMsg\(msg\)/g) ?? []).toHaveLength(1);
    expect(src).toContain('const longPressMessage = useCallback');
  });
});

describe('B-450 — DepartmentChatScreen: ANY attachment kind is not a dead zone', () => {
  it('the file card — which serves EVERY attachment kind here — opens the sheet', () => {
    // A dept channel renders photos, videos, voice notes and documents through
    // this ONE generic card (it keys off `m.media_object_key`, never off
    // `m.type`), so one handler covers every kind by construction.
    const c = code(DEPT);
    const at = c.indexOf('style={styles.fileCard}');
    expect(at).toBeGreaterThan(-1);
    expect(c.lastIndexOf('{!!m.media_object_key && (', at)).toBeGreaterThan(-1);
    expect(c.slice(0, at)).not.toMatch(/m\.type === 'image'/);
  });

  it('the file card opens the sheet on long-press', () => {
    const el = openingTag(code(DEPT), 'style={styles.fileCard}');
    expect(el).toMatch(/onLongPress=\{\(\) => \{ haptics\.impact\(\); setActionMsg\(m\); \}\}/);
    // Matching the bubble Pressable's delay, so the two feel like one surface.
    expect(el).toContain('delayLongPress={350}');
  });

  it('the quote strip does too', () => {
    const el = openingTag(code(DEPT), 'style={styles.replyStrip}');
    expect(el).toMatch(/onLongPress=\{\(\) => \{ haptics\.impact\(\); setActionMsg\(m\); \}\}/);
  });

  it('the admin-only reply rule is UNCHANGED', () => {
    // Opening the sheet is not permission to reply. `startReply` is the choke
    // point for both the sheet row and the swipe gesture (F7) and stays gated;
    // this commit only made the sheet reachable from an attachment.
    const src = code(DEPT);
    const at  = src.indexOf('const startReply = useCallback');
    expect(at).toBeGreaterThan(-1);
    const body  = src.slice(at, at + 400);
    const gate  = body.indexOf("if (myRole !== 'admin') {return;}");
    const arm   = body.indexOf('setReplyTo(');
    expect(gate).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(gate);
  });
});

describe('B-450 — replying WITH an attachment keeps its quote', () => {
  it('the sendMedia contract can carry a reply', () => {
    const src = code(IFACE);
    const at  = src.indexOf('sendMedia?(');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, src.indexOf('): Promise<void>;', at)))
      .toMatch(/replyTo\?:\s*\{messageId: string; preview: string\}/);
  });

  it('the optimistic bubble is stamped — sendText will NOT do it', () => {
    // sendMedia hands `existingMsgId`, which makes sendText skip its own
    // appendMessage, so this append is the author's only chance at a quote
    // strip. Without it the sender sees a bare photo and the recipient sees a
    // quote — the reverse of the asymmetry that hid B-144 for so long.
    const body = sendMediaBody();
    expect(body).toMatch(/reply_to_msg_id:\s*replyMeta\?\.msgId/);
    expect(body).toMatch(/reply_to_preview:\s*replyMeta\?\.preview/);
  });

  it('the preview is capped by the SHARED constant, never a fresh magic number', () => {
    // Two different caps = the author's quote strip and the recipient's render
    // different text for one message (B-145's rule, one layer up).
    const body = sendMediaBody();
    expect(body).toContain('REPLY_PREVIEW_MAX_CHARS');
    expect(body).not.toMatch(/slice\(0,\s*\d+\)/);
  });

  it('the wire copy rides the ONE existing send path — both lanes', () => {
    // sendText already ships the quote on every direct site AND on the group
    // OUTER seal + all three group outbox writers (B-144, pinned by
    // replyWireParity). Handing it over here means the group media lane needs
    // no second implementation — and a second one would be two sources of
    // truth for one field.
    const body = sendMediaBody();
    const at   = body.indexOf('runtimeApi.sendText(convId,');
    expect(at).toBeGreaterThan(-1);
    const call = body.slice(at, body.indexOf('});', at));
    expect(call).toMatch(/replyTo:\s+mediaOpts\?\.replyTo/);
    expect(call).toContain('existingMsgId: msgId');
  });

  it('ChatScreen snapshots the armed quote ONCE PER BATCH, before the runner starts', () => {
    // Two failures in one: the quote was dropped from the attachment, and it
    // stayed armed so it leaked onto the next TEXT message. The snapshot lives
    // in enqueueMediaAssets rather than per item so it is scoped to the RUN.
    const body    = enqueueMediaAssetsBody();
    const guard   = body.indexOf('if (mediaQueueRunning.current) {return;}');
    const snap    = body.indexOf('batchReplyRef.current = replyToRef.current;');
    const clearRef = body.indexOf('replyToRef.current = null;');
    const clearUi  = body.indexOf('setReplyTo(null);');
    const running  = body.indexOf('mediaQueueRunning.current = true;');
    expect(guard).toBeGreaterThan(-1);
    // AFTER the already-running guard — this is the whole point. A snapshot
    // taken before it would let a mid-drain enqueue steal the reply the user
    // armed for their NEXT message and staple it onto item N.
    expect(snap).toBeGreaterThan(guard);
    expect(clearRef).toBeGreaterThan(snap);
    expect(clearUi).toBeGreaterThan(snap);
    // Disarmed before the runner is marked live, so the composer is honest the
    // moment the first byte is read.
    expect(running).toBeGreaterThan(clearUi);
  });

  it('the batch quote reaches the FIRST item only, and is handed back if unused', () => {
    const send = sendPickedMediaBody();
    const take = send.indexOf('const replySnapshot = batchReplyRef.current;');
    expect(take).toBeGreaterThan(-1);
    // Taking it CLEARS it, so items 2..N of a multi-pick see null. Reading the
    // live `replyToRef` here instead is precisely the bug: a reply armed while
    // photo 3 of 5 uploads would attach itself to photo 4.
    expect(send.indexOf('batchReplyRef.current = null;')).toBeGreaterThan(take);
    expect(send).not.toContain('const replySnapshot = replyToRef.current;');
    // ...and if the whole batch bailed before consuming it (the 50 MB cap
    // `return`s without throwing), the runner's finally re-arms it rather than
    // parking it in the ref for the next, unrelated batch to inherit.
    const fin = enqueueMediaAssetsBody();
    expect(fin).toContain('} finally {');
    const restore = fin.indexOf('const unused = batchReplyRef.current;');
    expect(restore).toBeGreaterThan(-1);
    expect(fin.indexOf('setReplyTo(cur => cur ?? unused);')).toBeGreaterThan(restore);
  });

  it('a failure that left NO retryable row re-arms the quote', () => {
    // sendMedia appends its bubble only after its own pre-flight, so an offline
    // / key-pending throw leaves nothing on screen — no retry chip, and the
    // quote was already consumed. Silently losing it makes the user retype.
    const body = sendPickedMediaBody();
    const rows = body.indexOf('rowsBefore = new Set(');
    const send = body.indexOf('rt.sendMedia!(');
    const cat  = body.indexOf('} catch (e) {');
    expect(rows).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(rows);
    expect(cat).toBeGreaterThan(send);
    const handler = body.slice(cat);
    expect(handler).toContain('const left = after.some(m => !rowsBefore!.has(m.id));');
    expect(handler).toContain('if (!left) {');
    // Functional update: a reply the user armed WHILE this was in flight wins.
    // A bare setReplyTo(restore) would silently clobber it.
    expect(handler).toContain('setReplyTo(cur => cur ?? restore);');
  });

  it('a quote whose message was deleted for everyone is dropped, not shipped', () => {
    // reply_to_preview is PLAINTEXT of the quoted message. Shipping it after a
    // delete-for-everyone re-publishes the body its author just retracted, to a
    // recipient whose own copy already renders as a tombstone.
    const body = sendPickedMediaBody();
    const look = body.indexOf('const quotedNow = replySnapshot');
    const meta = body.indexOf('replyMeta = replySnapshot && !quotedNow?.deleted_for_all ? replySnapshot : null;');
    const send = body.indexOf('rt.sendMedia!(');
    expect(look).toBeGreaterThan(-1);
    expect(meta).toBeGreaterThan(look);
    expect(send).toBeGreaterThan(meta);
    // The WIRE reads the filtered value, never the raw snapshot — otherwise the
    // drop is cosmetic and the preview ships anyway.
    expect(body).toMatch(/replyTo:\s*replyMeta/);
    expect(body).not.toMatch(/replyTo:\s*replySnapshot/);
    // Absence from the loaded page is NOT deletion (older messages are paged
    // out), so only an explicit flag may drop the quote.
    expect(body).not.toMatch(/!quotedNow\b(?!\?)/);
  });

  it('the quote is read from a REF, not the closure the queue captured', () => {
    // `sendPickedMediaRef` is what the serial runner calls; a `replyTo` read
    // out of the useCallback closure is whatever it was when that closure was
    // minted, which for a queued item is arbitrarily stale.
    const src = code(CHAT);
    expect(src).toContain('replyToRef.current      = replyTo;');
    expect(sendPickedMediaBody()).not.toMatch(/const replySnapshot = replyTo;/);
  });
});

/**
 * DOCUMENTS B-462 — the TEXT send path never re-checks `deleted_for_all`.
 *
 * PINS THE CURRENT, BROKEN BEHAVIOUR. Pre-existing since B-144; deliberately
 * NOT fixed in this round.
 *
 * `startReply` refuses to arm a quote of a tombstone, so the state is clean at
 * ARM time — which is exactly what hides this. The gap is the compose window:
 * the user arms a reply, types for tens of seconds, and the peer deletes the
 * quoted message for everyone in the meantime. `send` reads the snapshot it
 * took at tap time and ships `replyTo.preview` — up to
 * REPLY_PREVIEW_MAX_CHARS of the PLAINTEXT its author just retracted — to a
 * recipient whose own copy already renders as "This message was deleted".
 *
 * The MEDIA lane closed exactly this at consume time (see the
 * `quotedNow` / `replyMeta` check pinned above), so the two lanes now disagree
 * about the same rule — which is the state most likely to be "tidied" in the
 * wrong direction, hence this pin.
 *
 * WHEN FIXED: the text send site must look the quoted row up in the store and
 * drop the quote when it is `deleted_for_all`, mirroring the media lane. These
 * assertions must then become the media lane's shape —
 *   expect(body).toMatch(/const quotedNow = replySnapshot/)
 *   expect(body).toMatch(/replyTo:\s*replyMeta/)
 *   expect(body).not.toMatch(/replyTo:\s*replySnapshot/)
 * — with the same "absence from the loaded page is NOT deletion" rule (only an
 * explicit flag may drop it), and this describe block renamed off DOCUMENTS.
 */
describe('DOCUMENTS B-462 — the TEXT send ships a quote of a since-deleted message', () => {
  it('the arm-time guard exists, which is why the send-time gap is invisible', () => {
    // Stated first so the flip commit does not "fix" this by re-checking at arm
    // time, where it already holds — the defect is strictly about the window
    // BETWEEN arming and sending.
    const src = code(CHAT);
    const at  = src.indexOf('const startReply = useCallback');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 300)).toContain('if (msg.deleted_for_all) {return;}');
  });

  it('send snapshots the armed quote and ships it UNFILTERED', () => {
    const body = sendTextBody();
    // Window-anchored to the TEXT lane: the media lane reads
    // `batchReplyRef.current`, so this anchor cannot drift onto the code that
    // was already fixed.
    expect(body).toContain('const replySnapshot = replyTo;');
    expect(body).not.toContain('batchReplyRef');
    const send = body.indexOf('runtime.sendText(conversationId, trimmed, {');
    expect(send).toBeGreaterThan(-1);
    const call = body.slice(send, body.indexOf('});', send));
    // TODAY: the raw snapshot reaches the wire.
    expect(call).toMatch(/replyTo:\s*replySnapshot/);
    expect(call).toContain('preview: replySnapshot.preview');
  });

  it('...with no store re-read of the quoted row anywhere in that path', () => {
    // The absence IS the bug. Comment-stripped, so the prose above (which names
    // every one of these tokens) cannot satisfy it.
    const body = sendTextBody();
    expect(body).not.toContain('deleted_for_all');
    expect(body).not.toContain('quotedNow');
    expect(body).not.toContain('replyMeta');
  });

  it('CONTROL — the media lane really does have the check this one lacks', () => {
    // Proves the asymmetry is real rather than an artefact of the window above,
    // and fails loudly if someone "harmonises" the two lanes by deleting the
    // media check instead of adding the text one.
    const media = sendPickedMediaBody();
    expect(media).toContain('deleted_for_all');
    expect(media).toMatch(/replyTo:\s*replyMeta/);
  });
});

describe('DOCUMENTS B-450b — the DEPT media send still drops an armed quote', () => {
  it('DepartmentChatScreen.sendPickedMedia does not pass replyTo (yet)', () => {
    // NOT fixed here, deliberately: unlike ChatScreen's, the dept media lane
    // has NO `myRole === 'admin'` re-check of its own (its text `send` repeats
    // the gate at F7 precisely because hiding the sheet row is not the
    // boundary), so carrying an admin-only affordance through it needs that
    // gate designed first. Consequence today: a dept admin replying with an
    // attachment loses the quote and it leaks onto their next text message.
    //
    // WHEN FIXED: this assertion must become the ChatScreen one —
    //   expect(body).toMatch(/replyTo:\s*replySnapshot/)
    // plus the role gate — and this describe block renamed off DOCUMENTS.
    const src   = code(DEPT);
    const start = src.indexOf('const sendPickedMedia = useCallback');
    const end   = src.indexOf('const sendPickedMediaRef', start);
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, end);
    expect(body).toContain('rt.sendMedia(');
    expect(body).not.toContain('replyTo');
  });
});
