/**
 * B-703 MR-4 / B-683 F4 — "did the relay already take this send?"
 *
 * One rule with two callers: the MSG-07 boot sweep (which flips a hydrated
 * 'sending' row to 'sent' rather than showing a retry chip for a message the
 * relay holds) and the HTTP-fallback catch (which must not stamp 'failed' over
 * an accept that landed while the retry was in flight).
 */
import {
  acceptedDuringAttempt,
  hasAcceptanceArtifact,
  snapshotAcceptance,
  wasSendAccepted,
  type SendAcceptanceProbe,
} from '../runtime/sendAcceptance';

describe('hasAcceptanceArtifact — what the relay handed back', () => {
  it('an envelope id proves acceptance', () => {
    expect(hasAcceptanceArtifact({envelope_id: 'env-1'})).toBe(true);
  });

  it('a retract token ALONE proves acceptance — the reachable kill-window residue', () => {
    // B-683/F4: every lane writes the retract token BEFORE the envelope id, so
    // token-without-id is an ordering artifact, not an inconsistency.
    expect(hasAcceptanceArtifact({retract_token: 'rt-1'})).toBe(true);
  });

  it('a non-empty per-recipient map proves acceptance (group fan-out)', () => {
    expect(hasAcceptanceArtifact({envelope_ids: {bob: 'e1'}})).toBe(true);
    expect(hasAcceptanceArtifact({retract_tokens: {bob: 't1'}})).toBe(true);
  });

  it('EMPTY maps are not artifacts — a fan-out where nothing shipped', () => {
    expect(hasAcceptanceArtifact({envelope_ids: {}, retract_tokens: {}})).toBe(false);
  });

  it('a bare optimistic row has no artifact', () => {
    expect(hasAcceptanceArtifact({status: 'sending'})).toBe(false);
    expect(hasAcceptanceArtifact({})).toBe(false);
  });

  it('null/undefined artifact fields are not acceptance', () => {
    expect(hasAcceptanceArtifact({
      envelope_id: null, retract_token: null, envelope_ids: null, retract_tokens: null,
    })).toBe(false);
    expect(hasAcceptanceArtifact({envelope_id: ''})).toBe(false);
  });
});

describe('wasSendAccepted — artifact OR an already-advanced status', () => {
  const row = (o: SendAcceptanceProbe): SendAcceptanceProbe => o;

  it.each(['sent', 'delivered', 'read'])('status %s means the server has it', s => {
    expect(wasSendAccepted(row({status: s}))).toBe(true);
  });

  it('REGRESSION B-703 MR-4: an artifact counts even while the status still reads sending', () => {
    // The live race: handleAccepted writes the envelope id and the status in
    // two separate store calls, and a silent miss on either must not make the
    // fallback catch believe the send failed.
    expect(wasSendAccepted(row({status: 'sending', envelope_id: 'srv-late'}))).toBe(true);
  });

  it('a genuinely un-accepted send is still failable', () => {
    expect(wasSendAccepted(row({status: 'sending'}))).toBe(false);
    expect(wasSendAccepted(row({status: 'failed'}))).toBe(false);
    expect(wasSendAccepted(row({status: 'undelivered'}))).toBe(false);
    expect(wasSendAccepted(row({}))).toBe(false);
  });

  it('is not fooled by a status-like string', () => {
    expect(wasSendAccepted(row({status: 'not-sent'}))).toBe(false);
    expect(wasSendAccepted(row({status: 'SENT'}))).toBe(false);
  });
});

describe('acceptedDuringAttempt — did the relay take THIS attempt?', () => {
  const before = snapshotAcceptance;

  it('a first send whose accept lands mid-flight', () => {
    const b = before({status: 'sending'});
    expect(acceptedDuringAttempt(b, {status: 'sent', envelope_id: 'env-1'})).toBe(true);
  });

  it('status-only acceptance counts (the two store writes are separate)', () => {
    // handleAccepted writes the status and the envelope id in separate store
    // calls; a miss on the id must not hide the accept.
    const b = before({status: 'sending'});
    expect(acceptedDuringAttempt(b, {status: 'sent'})).toBe(true);
  });

  it('REGRESSION (critic L1): a STALE round-1 artifact is not proof for round 2', () => {
    // The 1:1 retry lane keeps round-1 artifacts (only the group lane clears
    // them), so on every undelivered retry the bubble already carries one.
    // Treating that as acceptance swallows a genuine round-2 failure and leaves
    // the bubble spinning with no chip and no banner — with no durable queue
    // behind it, that is a LOST message, strictly worse than a false chip.
    const b = before({status: 'sending', envelope_id: 'env-round1', retract_token: 'rt-round1'});
    expect(acceptedDuringAttempt(b, {status: 'sending', envelope_id: 'env-round1', retract_token: 'rt-round1'}))
      .toBe(false);
  });

  it('...but a NEW artifact on the same row IS proof', () => {
    const b = before({status: 'sending', envelope_id: 'env-round1'});
    expect(acceptedDuringAttempt(b, {status: 'sent', envelope_id: 'env-round2'})).toBe(true);
  });

  it('a fresh retract token alone is proof (it is written before the envelope id)', () => {
    const b = before({status: 'sending', envelope_id: 'env-round1', retract_token: 'rt-round1'});
    expect(acceptedDuringAttempt(b, {status: 'sending', envelope_id: 'env-round1', retract_token: 'rt-round2'}))
      .toBe(true);
  });

  it('a row that never became accepted is never "accepted during"', () => {
    expect(acceptedDuringAttempt(before({status: 'sending'}), {status: 'sending'})).toBe(false);
    expect(acceptedDuringAttempt(before({status: 'sending'}), null)).toBe(false);
    expect(acceptedDuringAttempt(before({status: 'sending'}), undefined)).toBe(false);
  });

  it('a row that vanished mid-attempt fails open to "not accepted"', () => {
    // The B-18 fold can move the array between slots; falling through to the
    // honest failure path is the safe direction.
    expect(acceptedDuringAttempt(before(undefined), undefined)).toBe(false);
  });
});
