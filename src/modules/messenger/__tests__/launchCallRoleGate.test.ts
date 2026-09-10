/**
 * Unit tests for blockReasonForOutgoingCall — the role gate that
 * prevents CP Agents from placing direct 1:1 calls to individual
 * customers. The documented flow is: customer initiates, or ops
 * dispatch initiates. Agent-driven 1:1 dials are blocked here.
 *
 * Background: pre-fix, an agent tapping the dial button in a direct
 * conversation would navigate to CallScreen and ring the customer.
 * The PM flagged this as a bug under "5. CP Agent → Normal User
 * call issue" alongside the FGS-crash that prevented every call from
 * connecting at all.
 */
import {blockReasonForOutgoingCall} from '../webrtc/callRoleGate';

describe('blockReasonForOutgoingCall', () => {
  describe('non-agent initiators are never blocked', () => {
    it.each([
      ['individual', 'direct'],
      ['individual', 'group'],
      ['individual', 'ops_channel'],
      ['corporate',  'direct'],
      ['ops',        'direct'],
      [undefined,    'direct'],
    ] as const)('role=%s convoType=%s → allowed', (role, ct) => {
      expect(blockReasonForOutgoingCall(role, ct as 'direct' | 'group' | 'ops_channel', false)).toBeNull();
    });
  });

  describe('agent initiators', () => {
    it('agent → direct 1:1 is BLOCKED with a user-facing reason', () => {
      const reason = blockReasonForOutgoingCall('agent', 'direct', false);
      expect(reason).not.toBeNull();
      expect(reason).toMatch(/cannot start direct calls/i);
    });

    it('agent → ops_channel direct is allowed (dispatch workflow)', () => {
      expect(blockReasonForOutgoingCall('agent', 'ops_channel', false)).toBeNull();
    });

    it('agent → group call is allowed (mission room)', () => {
      expect(blockReasonForOutgoingCall('agent', 'group', true)).toBeNull();
    });

    it('agent → unknown convoType but isGroup=true is allowed', () => {
      // Defensive: launchCall passes isGroup separately because the
      // helper also detects 3+ participant direct convos as group.
      expect(blockReasonForOutgoingCall('agent', undefined, true)).toBeNull();
    });

    it('agent → unknown convoType direct is BLOCKED (safe default)', () => {
      const reason = blockReasonForOutgoingCall('agent', undefined, false);
      expect(reason).not.toBeNull();
    });
  });
});
