/**
 * [CALLLAT] marker coverage — audit Step 0
 * (docs/audits/CALL_JOIN_LATENCY_AUDIT_2026-08-20.md §7 Step 0).
 *
 * Static source scan (the call files cannot be imported by this project):
 * every step of the call-join waterfall has a release-visible marker AT ITS
 * SITE, duplicated steps are pinned by COUNT (review round 2: "exists
 * somewhere in the file" let a deleted site stay green), every marker call is
 * ONE line (so the banned-field check below is sound), the helper emits on
 * the `warn` channel, no marker carries an SDP / candidate / key / name field,
 * the controller LATCHES its lane at claim time, and the relay's OFFER-recv /
 * ICE-ignored / SFU-duration lines exist. Line-based, comment-stripped,
 * CRLF-safe — the usual rules for this repo's scans.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Conservative comment stripper: whole-line `//` and `/* … *\/` blocks only. */
function codeLines(src: string): string[] {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l));
}

const MARKER_CALL = /\b(logCallLat|this\.lat|latG|latSetupFrameEmitted)\(/;

function markerLines(rel: string): string[] {
  return codeLines(read(rel)).filter(l => MARKER_CALL.test(l));
}

function countStep(rel: string, step: string): number {
  return markerLines(rel).filter(l => l.includes(`'${step}'`) || l.includes('`' + step + '`')).length;
}

function expectStep(rel: string, step: string, count = 1): void {
  const n = countStep(rel, step);
  if (n !== count) {
    throw new Error(`[CALLLAT] marker '${step}' expected ${count}× in ${rel}, found ${n} (on logCallLat/lat/latG call lines)`);
  }
}

/** step → expected count (1 unless the step is legitimately stamped at N sites). */
const CLIENT: Record<string, Record<string, number>> = {
  'src/modules/messenger/webrtc/callController.ts': {
    'pc:built': 2, 'media:attached': 2, 'offer:created': 1, 'offer:auth': 1, 'remote-offer:applied': 1,
    'pending-ice:drained': 2, 'answer:created': 1, 'answer:applied': 1, 'ice:gate-open': 1,
    'ice:first-local': 1, 'dtls:ok': 1,
    'reoffer:sent': 2, 'reoffer:received': 1, 'reanswer:sent': 1, 'reanswer:received': 1, 'reanswer:applied': 1,
  },
  'src/modules/messenger/webrtc/signallingClient.ts': {'offer:emitted': 1, 'answer:emitted': 1},
  'src/modules/messenger/webrtc/useCall.ts': {'media:start': 1, 'media:ok': 1, 'controller:ready': 1, 'audio:first-inbound': 1},
  'src/screens/messenger/CallScreen.tsx': {
    'transport:live': 1, 'turn:start': 1, 'turn:ok': 1, 'turn:fail': 1, 'tap:accept': 2,
    'accept:invoke': 1, 'accept:wait-controller': 1, 'audio-session:start': 1,
  },
  'src/modules/messenger/webrtc/launchCall.ts': {'launch': 1},
  'src/modules/messenger/webrtc/useGroupCall.ts': {
    'boot': 1, 'turn:start': 1, 'turn:resolved': 1, 'room:created': 1, 'room:existing': 1, 'media:start': 1,
    'media:ok': 1, 'join:sent': 1, 'join:ack': 1, 'key:ensure-start': 1, 'key:ensured': 1, 'key:wait-start': 1,
    'key:arrived': 1, 'ring:send': 1, 'ring:ack': 1, 'device:load-start': 1, 'device:loaded': 1,
    'turn:awaited': 1, 'transports:created': 1, 'produce:start': 1, 'produce:audio-ok': 1,
    'produce:video-ok': 1, 'consume:start': 1, 'consume:done': 1, 'consume:ack': 1, 'consume:sdp': 1,
    'consume:cryptor': 1, 'consume:resumed': 1, 'presence:start': 1, 'presence:done': 1, 'state:joined': 1,
    'audio:first-inbound': 1,
  },
  'src/screens/messenger/GroupCallScreen.tsx': {'audio-session:wait-bt': 1, 'audio-session:start': 1},
  // §1.2 N1 — the notification / Telecom answer lanes (round 2).
  'src/modules/messenger/push/fcmBootstrap.ts': {'notif:answer-tap': 2, 'nav:ready': 2},
  // The true lane origins: offer/ring reached this device.
  'src/navigation/MainNavigator.tsx': {'offer:received': 1, 'ring:received': 1},
};

/** Rows that carry their own interval (`ms=`) and must not rely on `dt` alone. */
const MS_ROWS: Array<[string, string]> = [
  ['src/screens/messenger/CallScreen.tsx', 'turn:ok'],
  ['src/modules/messenger/webrtc/useGroupCall.ts', 'turn:resolved'],
  ['src/modules/messenger/webrtc/useGroupCall.ts', 'media:ok'],
  ['src/modules/messenger/webrtc/useGroupCall.ts', 'join:ack'],
  ['src/modules/messenger/webrtc/useGroupCall.ts', 'key:ensured'],
  ['src/modules/messenger/webrtc/useGroupCall.ts', 'key:arrived'],
  ['src/modules/messenger/webrtc/useGroupCall.ts', 'ring:ack'],
  ['src/modules/messenger/webrtc/useGroupCall.ts', 'device:loaded'],
  ['src/modules/messenger/webrtc/useGroupCall.ts', 'turn:awaited'],
  ['src/modules/messenger/webrtc/useGroupCall.ts', 'produce:audio-ok'],
  ['src/modules/messenger/webrtc/useGroupCall.ts', 'produce:video-ok'],
  ['src/modules/messenger/webrtc/useGroupCall.ts', 'consume:ack'],
  ['src/modules/messenger/webrtc/useGroupCall.ts', 'consume:resumed'],
  ['src/modules/messenger/webrtc/useGroupCall.ts', 'presence:done'],
];

describe('[CALLLAT] markers — audit Step 0', () => {
  it('the helper emits on console.warn (release-visible) with the [CALLLAT] prefix, ids only', () => {
    const src = read('src/modules/messenger/runtime/callDiag.ts');
    const lines = codeLines(src);
    const start = lines.findIndex(l => /export function logCallLat\(/.test(l));
    expect(start).toBeGreaterThan(-1);
    const body = lines.slice(start, start + 40).join('\n');
    expect(body).toMatch(/console\.warn\(formatCallLat\(/);
    expect(body).not.toMatch(/console\.log\(/);
    const fmt = lines.slice(lines.findIndex(l => /function formatCallLat\(/.test(l)), lines.length).join('\n');
    expect(fmt).toMatch(/\[CALLLAT\] lane=\$\{lane\} cid=\$\{cid\} step=\$\{step\} t=\$\{t\} dt=\$\{dt\}/);
  });

  for (const [rel, steps] of Object.entries(CLIENT)) {
    for (const [step, count] of Object.entries(steps)) {
      it(`${path.basename(rel)} carries '${step}' ${count}× at its site(s)`, () => { expectStep(rel, step, count); });
    }
  }

  it('every marker call is a single line (keeps the field scan below sound)', () => {
    for (const rel of Object.keys(CLIENT)) {
      for (const l of markerLines(rel)) {
        const open = (l.match(/\(/g) ?? []).length;
        const close = (l.match(/\)/g) ?? []).length;
        if (open !== close) {throw new Error(`${rel}: multi-line marker call — ${l.trim()}`);}
      }
    }
  });

  it('callController stamps every accepted state transition and each ICE state, latches its lane at claim time, and ends the lane on a terminal transition', () => {
    const lines = codeLines(read('src/modules/messenger/webrtc/callController.ts'));
    const markers = lines.filter(l => MARKER_CALL.test(l));
    expect(markers.some(l => l.includes('`state:${next}`'))).toBe(true);
    expect(markers.some(l => l.includes('`ice:${ice}`'))).toBe(true);
    // Round 2: the lane is latched when the call is CLAIMED (end() nulls the
    // descriptor before its terminal setState) — both claim sites, and the
    // helper + the terminal endCallLatLane read the latch, never the descriptor.
    expect(lines.filter(l => /this\.latLane = '1to1-out';/.test(l)).length).toBe(1);
    expect(lines.filter(l => /this\.latLane = '1to1-in';/.test(l)).length).toBe(1);
    const helper = lines.findIndex(l => /private lat\(step: string/.test(l));
    expect(lines.slice(helper, helper + 3).join('\n')).toMatch(/logCallLat\(this\.latLane,/);
    const i = lines.findIndex(l => l.includes('`state:${next}`'));
    expect(lines.slice(i, i + 6).join('\n')).toMatch(/endCallLatLane\(this\.latLane,/);
    expect(lines.some(l => /endCallLatLane\(d\?\.direction/.test(l))).toBe(false);
  });

  it('the "first sight of a call" rows use freshAfterMs (continue a young clock, never inherit a stale one)', () => {
    const sites: Array<[string, string]> = [
      ['src/navigation/MainNavigator.tsx', 'offer:received'],
      ['src/navigation/MainNavigator.tsx', 'ring:received'],
      ['src/modules/messenger/push/fcmBootstrap.ts', 'notif:answer-tap'],
    ];
    for (const [rel, step] of sites) {
      const ls = markerLines(rel).filter(l => l.includes(`'${step}'`));
      expect(ls.length).toBeGreaterThan(0);
      for (const l of ls) {expect(l).toMatch(/freshAfterMs/);}
    }
    // The group boot row: a host START resets, an invitee boot continues.
    const boot = markerLines('src/modules/messenger/webrtc/useGroupCall.ts').find(l => l.includes("'boot'")) ?? '';
    const bootSrc = codeLines(read('src/modules/messenger/webrtc/useGroupCall.ts'));
    const bi = bootSrc.findIndex(l => l.includes("latG('boot'"));
    expect(bootSrc.slice(Math.max(0, bi - 1), bi + 1).join(' ')).toMatch(/freshAfterMs: 90_000\} : \{reset: true\}/);
    expect(boot).toContain("'boot'");
    // The caller lane resets at the launch tap.
    expect(markerLines('src/modules/messenger/webrtc/launchCall.ts').some(l => l.includes("'launch'") && /reset: true/.test(l))).toBe(true);
  });

  it('interval rows carry their own ms= field (dt is "since the previous marker of ANY kind")', () => {
    for (const [rel, step] of MS_ROWS) {
      const ls = markerLines(rel).filter(l => l.includes(`'${step}'`));
      expect(ls.length).toBeGreaterThan(0);
      for (const l of ls) {
        if (!/\b(ms|waitMs):/.test(l)) {throw new Error(`${rel}: '${step}' has no ms= field — ${l.trim()}`);}
      }
    }
  });

  it('the group lane ends its clock on a TERMINAL state (the twin of the 1:1 state:ended row)', () => {
    const lines = codeLines(read('src/modules/messenger/webrtc/useGroupCall.ts'));
    const i = lines.findIndex(l => /if \(GROUP_TERMINAL_STATES\.has\(next\)\)/.test(l));
    expect(i).toBeGreaterThan(-1);
    const block = lines.slice(i, i + 4).join('\n');
    expect(block).toMatch(/latG\(`state:\$\{next\}`/);
    expect(block).toMatch(/endCallLatLane\(opts\.direction === 'incoming' \? 'grp-join' : 'grp-host', opts\.conversationId\)/);
  });

  it('a js-stall row never counts as lane liveness (Edge row 31)', () => {
    const diag = codeLines(read('src/modules/messenger/runtime/callDiag.ts'));
    const i = diag.findIndex(l => /export function markJsStallOnActiveLanes\(/.test(l));
    expect(diag.slice(i, i + 12).join('\n')).toMatch(/stampLane\(c\.lane, c\.id, 'js-stall', \{driftMs\}, undefined, false\)/);
    const s = diag.findIndex(l => /^function stampLane\(/.test(l));
    expect(diag.slice(s, s + 30).join('\n')).toMatch(/if \(touch\) \{clock\.touched = now;\}/);
  });

  it('the js-stall row is wired from the JS-thread watchdog onto live lanes', () => {
    const wd = codeLines(read('src/utils/jsThreadWatchdog.ts')).join('\n');
    expect(wd).toMatch(/markJsStallOnActiveLanes\(drift\)/);
    const diag = codeLines(read('src/modules/messenger/runtime/callDiag.ts'));
    const i = diag.findIndex(l => /export function markJsStallOnActiveLanes\(/.test(l));
    expect(i).toBeGreaterThan(-1);
    expect(diag.slice(i, i + 12).join('\n')).toMatch(/stampLane\(c\.lane, c\.id, 'js-stall', \{driftMs\}, undefined, false\)/);
  });

  it('no marker line carries an SDP, candidate string, key, token or display-name field', () => {
    // A FIELD is `{k:` / `, k:` (explicit) or `{k}` / `, k}` / `, k,` (shorthand)
    // inside the fields object — a step name such as 'key:ensure-start' sits
    // inside quotes after `(` and must not trip this.
    const banned = /[{,]\s*(sdp|candidate|key|secret|token|name|displayName|callerName|credential|username|password)\s*[:,}]/;
    for (const rel of Object.keys(CLIENT)) {
      for (const l of markerLines(rel)) {
        if (banned.test(l)) {
          throw new Error(`${rel}: marker line carries a banned field: ${l.trim()}`);
        }
      }
    }
  });

  it('relay: OFFER recv is stamped BEFORE the privacy await; ICE drops are countable; SFU handlers log ms from their first line', () => {
    const lines = codeLines(read('apps/messenger-service/src/gateway/messenger.gateway.ts'));
    const offerStart = lines.findIndex(l => /@SubscribeMessage\('call\.offer'\)/.test(l));
    expect(offerStart).toBeGreaterThan(-1);
    // Window = the whole handler (bounded by the next @SubscribeMessage), not a
    // fixed line count: Step 1 pushed the gate down, and later steps may add
    // lines above it — a fixed slice would false-RED (Edge review).
    const nextHandler = lines.findIndex((l, i) => i > offerStart && /@SubscribeMessage\(/.test(l));
    const handler = lines.slice(offerStart, nextHandler === -1 ? offerStart + 120 : nextHandler);
    const recvIdx  = handler.findIndex(l => l.includes('[CALL] OFFER recv'));
    // Step 1 (B-597) bounded the call lane's gate: the first await is now
    // `await this.privacyGateBounded(` — the recv stamp must still precede it.
    const awaitIdx = handler.findIndex(l => l.includes('await this.privacyGateBounded(') || l.includes('await this.privacy.isBlockedEither('));
    expect(recvIdx).toBeGreaterThan(-1);
    expect(awaitIdx).toBeGreaterThan(-1);
    expect(recvIdx).toBeLessThan(awaitIdx);

    const iceStart = lines.findIndex(l => /@SubscribeMessage\('call\.ice'\)/.test(l));
    const iceHandler = lines.slice(iceStart, iceStart + 50).join('\n');
    expect(iceHandler).toMatch(/console\.warn\(`\[CALL\] ICE ignored cid=/);

    for (const ev of ['join.ack', 'transport.connect', 'produce', 'consume', 'consumer.resume']) {
      expect(lines.some(l => l.includes(`[SFU] ${ev} rid=`) && l.includes('ms='))).toBe(true);
    }
    // Round 2: join's clock starts BEFORE the awaited Redis rate counter.
    const joinStart = lines.findIndex(l => /@SubscribeMessage\('sfu\.join'\)/.test(l));
    const joinHandler = lines.slice(joinStart, joinStart + 40);
    const t0Idx = joinHandler.findIndex(l => l.includes('const joinT0 = Date.now();'));
    const rateIdx = joinHandler.findIndex(l => l.includes("userRateExceeded(ctx.claims.sub, 'sfujoin'"));
    expect(t0Idx).toBeGreaterThan(-1);
    expect(rateIdx).toBeGreaterThan(-1);
    expect(t0Idx).toBeLessThan(rateIdx);

    const sfu = codeLines(read('apps/messenger-service/src/sfu/sfu.service.ts')).join('\n');
    expect(sfu).toMatch(/tx\.on\('icestatechange'/);
    expect(sfu).toMatch(/tx\.on\('dtlsstatechange'/);
  });
});
