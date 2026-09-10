/**
 * B-99 RC-1 — VP8-first video codec preference (pure munge).
 *
 * Fixtures are faithful unified-plan libwebrtc shapes (audio m-line first,
 * rtx paired via a=fmtp apt=, ssrc-group FID). NOTE: written from libwebrtc
 * output structure, not captured off a live iPhone (no iOS device in the QA
 * loop yet) — replace with real captures when the device pair exists, per
 * CROSS_PLATFORM_CALL_VIDEO_LOOP.md §6 RC-1.
 */
import {preferVp8OnVideoMLine} from '../webrtc/sdpCodecPreference';

const CRLF = '\r\n';

const AUDIO_SECTION = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 110',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=rtpmap:110 telephone-event/48000',
  'a=mid:0',
].join(CRLF);

// iOS-style: hardware H264 profiles lead, VP8 buried mid-list.
const IOS_STYLE_OFFER = [
  AUDIO_SECTION,
  'm=video 9 UDP/TLS/RTP/SAVPF 102 103 104 105 96 97 98 99',
  'c=IN IP4 0.0.0.0',
  'a=mid:1',
  'a=rtpmap:102 H264/90000',
  'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f',
  'a=rtpmap:103 rtx/90000',
  'a=fmtp:103 apt=102',
  'a=rtpmap:104 H264/90000',
  'a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  'a=rtpmap:105 rtx/90000',
  'a=fmtp:105 apt=104',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:98 VP9/90000',
  'a=rtpmap:99 rtx/90000',
  'a=fmtp:99 apt=98',
  'a=ssrc-group:FID 1234 5678',
  'a=ssrc:1234 cname:abcd',
  'a=ssrc:5678 cname:abcd',
].join(CRLF) + CRLF;

// Android/Stream-style: VP8 first already (fix must be a no-op).
const ANDROID_STYLE_OFFER = [
  AUDIO_SECTION,
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 102 103',
  'c=IN IP4 0.0.0.0',
  'a=mid:1',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:98 VP9/90000',
  'a=rtpmap:99 rtx/90000',
  'a=fmtp:99 apt=98',
  'a=rtpmap:102 H264/90000',
  'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  'a=rtpmap:103 rtx/90000',
  'a=fmtp:103 apt=102',
].join(CRLF) + CRLF;

function videoMLine(sdp: string): string {
  return sdp.split(/\r?\n/).find(l => l.startsWith('m=video')) ?? '';
}
function audioSection(sdp: string): string {
  return sdp.slice(0, sdp.indexOf('m=video'));
}

describe('preferVp8OnVideoMLine (B-99 RC-1)', () => {
  it('moves VP8 + its rtx to the front of an H264-first (iOS-style) offer', () => {
    const out = preferVp8OnVideoMLine(IOS_STYLE_OFFER);
    expect(videoMLine(out)).toBe('m=video 9 UDP/TLS/RTP/SAVPF 96 97 102 103 104 105 98 99');
  });

  it('keeps every codec available (H264 retained, nothing stripped)', () => {
    const out = preferVp8OnVideoMLine(IOS_STYLE_OFFER);
    for (const pt of ['102', '103', '104', '105', '96', '97', '98', '99']) {
      expect(videoMLine(out)).toContain(pt);
    }
    // Attribute lines untouched — rtx pairing intact.
    expect(out).toContain('a=fmtp:97 apt=96');
    expect(out).toContain('a=fmtp:103 apt=102');
    expect(out).toContain('a=ssrc-group:FID 1234 5678');
  });

  it('leaves the audio m-line and session header byte-identical', () => {
    const out = preferVp8OnVideoMLine(IOS_STYLE_OFFER);
    expect(audioSection(out)).toBe(audioSection(IOS_STYLE_OFFER));
  });

  it('is a byte-identical no-op on an already-VP8-first (Android-style) offer', () => {
    expect(preferVp8OnVideoMLine(ANDROID_STYLE_OFFER)).toBe(ANDROID_STYLE_OFFER);
  });

  it('is idempotent', () => {
    const once = preferVp8OnVideoMLine(IOS_STYLE_OFFER);
    expect(preferVp8OnVideoMLine(once)).toBe(once);
  });

  it('no-ops on audio-only SDP (no video m-line)', () => {
    const audioOnly = AUDIO_SECTION + CRLF;
    expect(preferVp8OnVideoMLine(audioOnly)).toBe(audioOnly);
  });

  it('no-ops when the video section has no VP8', () => {
    const h264Only = IOS_STYLE_OFFER
      .split(/\r?\n/).filter(l => !/rtpmap:(96|97|98|99)|fmtp:(97|99)/.test(l))
      .join(CRLF)
      .replace('m=video 9 UDP/TLS/RTP/SAVPF 102 103 104 105 96 97 98 99',
               'm=video 9 UDP/TLS/RTP/SAVPF 102 103 104 105');
    expect(preferVp8OnVideoMLine(h264Only)).toBe(h264Only);
  });

  it('never throws on malformed input', () => {
    expect(preferVp8OnVideoMLine('')).toBe('');
    expect(preferVp8OnVideoMLine('m=video')).toBe('m=video');
    expect(preferVp8OnVideoMLine('garbage\nm=video 9 X\nmore')).toBe('garbage\nm=video 9 X\nmore');
  });

  it('preserves bare-LF line endings when a stack emits them', () => {
    const lf = IOS_STYLE_OFFER.replace(/\r\n/g, '\n');
    const out = preferVp8OnVideoMLine(lf);
    expect(out).not.toContain('\r');
    expect(out.split('\n').find(l => l.startsWith('m=video')))
      .toBe('m=video 9 UDP/TLS/RTP/SAVPF 96 97 102 103 104 105 98 99');
  });
});
