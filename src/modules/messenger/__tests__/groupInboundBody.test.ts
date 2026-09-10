/**
 * B-25 — keyless group text must render the message body, not raw JSON.
 *
 * When a sender lacks the group master key, the inner GroupMessageEnvelope
 * ships as PLAINTEXT JSON. parseGroupMessage rejects it (`malformed`,
 * Audit P0-G2), so the group-receive handler falls through to its legacy
 * plaintext path, which used to set `content: unwrapped.body` verbatim —
 * rendering `{"groupId":…,"kind":"text","clientMsgId":…,"body":"hi"}` in
 * the chat bubble and leaking the internal ids. unwrapPlaintextGroupInnerBody
 * recovers the inner `.body` while leaving genuine legacy plaintext (a bare
 * string from ops-console / server mission groups) untouched.
 */

import {unwrapPlaintextGroupInnerBody} from '../runtime/groupInboundBody';

const GROUP_ID = '3cb79cb1f1b0e0be3ff9c2df76344a0f';

describe('B-25 — unwrapPlaintextGroupInnerBody', () => {
  it('extracts the inner .body from a keyless plaintext inner envelope', () => {
    const inner = JSON.stringify({
      groupId: GROUP_ID, kind: 'text', clientMsgId: 'cmid-1', body: 'hi',
    });
    expect(unwrapPlaintextGroupInnerBody(inner, GROUP_ID)).toBe('hi');
  });

  it('does not leak groupId/clientMsgId into the rendered body', () => {
    const inner = JSON.stringify({
      groupId: GROUP_ID, kind: 'text', clientMsgId: 'leak-me', body: 'hello team',
    });
    const out = unwrapPlaintextGroupInnerBody(inner, GROUP_ID);
    expect(out).toBe('hello team');
    expect(out).not.toContain('groupId');
    expect(out).not.toContain('leak-me');
  });

  it('leaves a genuine bare-string plaintext body unchanged (ops/mission groups)', () => {
    expect(unwrapPlaintextGroupInnerBody('ops brief at 14:00', GROUP_ID))
      .toBe('ops brief at 14:00');
  });

  it('leaves an envelope for a DIFFERENT group unchanged (shape must match this group)', () => {
    const inner = JSON.stringify({
      groupId: 'some-other-group', kind: 'text', clientMsgId: 'x', body: 'hi',
    });
    expect(unwrapPlaintextGroupInnerBody(inner, GROUP_ID)).toBe(inner);
  });

  it('leaves a non-text (e.g. admin-shaped) JSON body unchanged', () => {
    const inner = JSON.stringify({
      groupId: GROUP_ID, kind: 'admin', clientMsgId: 'x', body: '',
    });
    expect(unwrapPlaintextGroupInnerBody(inner, GROUP_ID)).toBe(inner);
  });

  it('leaves a body whose .body is not a string unchanged', () => {
    const inner = JSON.stringify({
      groupId: GROUP_ID, kind: 'text', clientMsgId: 'x', body: {nested: true},
    });
    expect(unwrapPlaintextGroupInnerBody(inner, GROUP_ID)).toBe(inner);
  });

  it('leaves malformed JSON unchanged (no throw)', () => {
    expect(unwrapPlaintextGroupInnerBody('{not json', GROUP_ID)).toBe('{not json');
  });

  it('leaves a plaintext body that happens to start with "{" but is not an envelope', () => {
    expect(unwrapPlaintextGroupInnerBody('{ meet at the gate }', GROUP_ID))
      .toBe('{ meet at the gate }');
  });

  it('passes through an empty body without throwing', () => {
    expect(unwrapPlaintextGroupInnerBody('', GROUP_ID)).toBe('');
  });
});
