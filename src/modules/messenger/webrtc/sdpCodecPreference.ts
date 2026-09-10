/**
 * B-99 RC-1 — cross-platform 1:1 video codec preference.
 *
 * Android ships the Stream libwebrtc build (FrameCryptor patch) while iOS
 * runs the stock react-native-webrtc pod — two different codec/decoder
 * factories that were never validated against each other. When negotiation
 * lands the iPhone sender on an H.264 profile the Android receiver can't
 * decode, the track arrives but zero frames render (black tile / one-way
 * video). VP8 is the mandatory-to-implement software codec present in BOTH
 * builds, so we reorder the `m=video` payload-type list to put VP8 (and its
 * paired rtx) FIRST on every local offer/answer.
 *
 * Reorder ONLY — H264 and every other codec stay available as fallbacks
 * (Android↔Android hardware paths may still pick them), attribute lines
 * (`a=rtpmap`/`a=fmtp`/`a=ssrc-group`), the audio m-line and everything
 * else are byte-identical. Pure string→string, unit-tested in
 * `__tests__/sdpCodecPreference.test.ts`.
 */

/** Newline-preserving split: returns [line, terminator] pairs rebuilt as-is. */
function splitLines(sdp: string): string[] {
  // SDP is CRLF per RFC 4566 but some stacks emit bare LF — preserve either.
  return sdp.split(/(?<=\n)/);
}

/**
 * Reorder the video m-line's payload types so VP8 + its rtx come first.
 * Returns the input unchanged when there is no video m-line, no VP8
 * payload, or anything looks malformed (never throw on SDP we didn't
 * expect — a failed munge must not kill call setup).
 */
export function preferVp8OnVideoMLine(sdp: string): string {
  if (!sdp || typeof sdp !== 'string') {return sdp;}
  try {
    const lines = splitLines(sdp);

    // Locate the video m-line and the extent of its media section.
    const mIdx = lines.findIndex(l => l.startsWith('m=video'));
    if (mIdx === -1) {return sdp;}
    let sectionEnd = lines.length;
    for (let i = mIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('m=')) {sectionEnd = i; break;}
    }

    // m=video <port> <proto> <pt> <pt> ... — payloads are tokens 3+.
    const mLine = lines[mIdx];
    const eol = mLine.match(/\r?\n$/)?.[0] ?? '';
    const tokens = mLine.replace(/\r?\n$/, '').split(' ');
    if (tokens.length <= 3) {return sdp;}
    const payloads = tokens.slice(3);

    // Map payload types from the section's rtpmap/fmtp attributes.
    const vp8: string[] = [];
    const rtxByApt = new Map<string, string>();
    for (let i = mIdx + 1; i < sectionEnd; i++) {
      const rtpmap = lines[i].match(/^a=rtpmap:(\d+)\s+([A-Za-z0-9-]+)\//);
      if (rtpmap && rtpmap[2].toUpperCase() === 'VP8') {vp8.push(rtpmap[1]);}
      const fmtpApt = lines[i].match(/^a=fmtp:(\d+)\s+apt=(\d+)\s*$/);
      if (fmtpApt) {rtxByApt.set(fmtpApt[2], fmtpApt[1]);}
    }
    if (vp8.length === 0) {return sdp;}

    const front: string[] = [];
    for (const pt of vp8) {
      if (payloads.includes(pt)) {front.push(pt);}
      const rtx = rtxByApt.get(pt);
      if (rtx && payloads.includes(rtx)) {front.push(rtx);}
    }
    if (front.length === 0) {return sdp;}
    const rest = payloads.filter(pt => !front.includes(pt));
    const reordered = [...front, ...rest];
    if (reordered.join(' ') === payloads.join(' ')) {return sdp;} // already VP8-first

    lines[mIdx] = [...tokens.slice(0, 3), ...reordered].join(' ') + eol;
    return lines.join('');
  } catch {
    return sdp;
  }
}
