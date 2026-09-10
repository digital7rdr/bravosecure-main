/**
 * End-to-end smoke test for the Agent Portal onboarding flow.
 *
 * Walks a brand-new agent through every stage — AgentTypeSelect →
 * RegistrationWizard → KYC (server advances) → Coverage → Availability
 * → DocsUpload → submit → AdminApproval (Ops approves) →
 * DeploymentRequirements (Ops signs off) → AgentDashboard — and
 * verifies the right API calls fire in the right order.
 *
 * Uses mocked `agentApi` (no real HTTP) plus the pure helpers from
 * `agentFlowHelpers.ts` to simulate the screen-router behaviour.
 */

jest.mock('@services/api', () => {
  // Default bodies; individual tests override with mockResolvedValueOnce.
  return {
    __esModule: true,
    agentApi: {
      create:             jest.fn(),
      getMe:              jest.fn(),
      updateCompany:      jest.fn(),
      startKyc:           jest.fn(),
      updateCoverage:     jest.fn(),
      updateAvailability: jest.fn(),
      uploadDoc:          jest.fn(),
      submit:             jest.fn(),
      setDuty:            jest.fn(),
    },
  };
});

import {agentApi} from '@services/api';
import {
  nextStepFor,
  canSubmitForReview,
  coverageCountriesPayload,
  uiTypeToBackend,
} from '../agentFlowHelpers';

type Api = jest.Mocked<typeof agentApi>;
const api = agentApi as unknown as Api;

/** Re-usable fake /agents/me response. */
function makeMe(overrides: Partial<{
  status: string;
  type: string;
  display_name: string;
  company: Record<string, string>;
  capabilities: string[];
  coverage: {countries: Array<{code: string; on: boolean}>; services: Array<{key: string; on: boolean}>};
  availability: {mode: string; loadout: string[]};
  kyc: Array<{kind: string; state: string}>;
  documents: Array<{slot: string; required: boolean; state: string}>;
  review: Array<{step: string; state: string}>;
  deployment: Array<{check_key: string; state: string}>;
  on_duty: boolean;
  rating: string;
  jobs_total: number;
  duty_hours_mtd: number;
}> = {}) {
  return {
    data: {
      agent: {
        user_id: 'u-1',
        type: overrides.type ?? 'cpo',
        status: overrides.status ?? 'DRAFT',
        tier: 2,
        call_sign: 'AGT-44',
        display_name: overrides.display_name ?? 'Marcus Thornton',
        rate_aed_per_hour: '540',
        rating: overrides.rating ?? '4.92',
        jobs_total: overrides.jobs_total ?? 0,
        duty_hours_mtd: overrides.duty_hours_mtd ?? 0,
        on_duty: overrides.on_duty ?? false,
      },
      profile: {
        company:      overrides.company ?? {},
        contact:      {},
        capabilities: overrides.capabilities ?? [],
        coverage:     overrides.coverage ?? {countries: [], services: []},
        availability: overrides.availability ?? {mode: 'full', loadout: []},
      },
      kyc:        (overrides.kyc        ?? []).map(k => ({...k, subject: null})),
      documents:  (overrides.documents  ?? []).map(d => ({...d, id: d.slot, title: d.slot})),
      review:     overrides.review      ?? [],
      deployment: overrides.deployment  ?? [],
    },
  };
}

describe('Agent onboarding smoke — brand-new agent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('full lifecycle: TypeSelect → Dashboard', async () => {
    // ── 01 TypeSelect ── brand-new user, no row yet.
    api.getMe.mockRejectedValueOnce({response: {status: 404}});
    api.create.mockResolvedValueOnce({data: {user_id: 'u-1'}} as never);

    // Simulating the TypeSelect Continue button:
    //   1. call getMe → 404 → user stays on TypeSelect
    await expect(api.getMe()).rejects.toMatchObject({response: {status: 404}});
    //   2. Continue → create agent with backend type derived from UI pick
    await api.create(uiTypeToBackend('individual'));

    expect(api.create).toHaveBeenCalledWith('cpo');

    // After create, server row exists with DRAFT status.
    api.getMe.mockResolvedValueOnce(makeMe({status: 'DRAFT'}) as never);
    const afterCreate = await api.getMe();
    expect(nextStepFor(afterCreate.data.agent.status)).toBe('AgentRegistrationWizard');

    // ── 02 RegistrationWizard — save company details ──
    api.updateCompany.mockResolvedValueOnce({} as never);
    await api.updateCompany({
      legal_name: 'UK CP Ltd', company_number: 'SIA-2024-CP-441',
      regulator: 'UK SIA', established: '11/06/2017',
      primary_contact: 'Marcus Thornton',
      primary_email: 'm@ukcp.co.uk',
      primary_phone: '+447911234567',
      capabilities: ['first_aid', 'firearms'],
    });
    expect(api.updateCompany).toHaveBeenCalledTimes(1);

    // Submit tab kicks off KYC.
    api.startKyc.mockResolvedValueOnce({} as never);
    await api.startKyc();

    // Server returns KYC_PENDING after saving + kyc_start.
    api.getMe.mockResolvedValueOnce(makeMe({
      status: 'KYC_PENDING',
      kyc: [
        {kind: 'gov_id',        state: 'running'},
        {kind: 'proof_address', state: 'queued'},
        {kind: 'sia_licence',   state: 'queued'},
        {kind: 'police',        state: 'queued'},
      ],
    }) as never);
    const kycMid = await api.getMe();
    // KYC is folded into the compliance pack — `nextStepFor` returns
    // `AgentCoverage` for KYC_PENDING (see agentFlowHelpers.ts).
    expect(nextStepFor(kycMid.data.agent.status)).toBe('AgentCoverage');

    // ── 03 KYC polls — server settles all checks, agent moves to DOCS_PENDING
    api.getMe.mockResolvedValueOnce(makeMe({
      status: 'DOCS_PENDING',
      kyc: [
        {kind: 'gov_id',        state: 'done'},
        {kind: 'proof_address', state: 'done'},
        {kind: 'sia_licence',   state: 'done'},
        {kind: 'police',        state: 'done'},
      ],
    }) as never);
    const kycDone = await api.getMe();
    expect(kycDone.data.kyc.every(k => k.state === 'done')).toBe(true);
    expect(nextStepFor(kycDone.data.agent.status)).toBe('AgentDocsUpload');

    // ── 04 Coverage — save toggles ──
    api.updateCoverage.mockResolvedValueOnce({} as never);
    await api.updateCoverage({
      countries: coverageCountriesPayload([
        {key: 'ae', on: true}, {key: 'gb', on: true}, {key: 'sa', on: false}, {key: 'us', on: false},
      ]),
      services: [{key: 'cp', on: true}, {key: 'driving', on: true}, {key: 'advance', on: false}],
    });
    expect(api.updateCoverage.mock.calls[0][0].countries).toEqual([
      {code: 'AE', on: true}, {code: 'GB', on: true},
      {code: 'SA', on: false}, {code: 'US', on: false},
    ]);

    // ── 05 Availability — save mode + loadout ──
    api.updateAvailability.mockResolvedValueOnce({} as never);
    await api.updateAvailability({mode: 'full', loadout: ['armoured', 'sia']});
    expect(api.updateAvailability).toHaveBeenCalledWith({mode: 'full', loadout: ['armoured', 'sia']});

    // ── 06 Docs — upload all 4 required slots, then submit ──
    const DOCS = [
      {slot: 'sia',       required: true,  state: 'upload'},
      {slot: 'passport',  required: true,  state: 'upload'},
      {slot: 'insurance', required: true,  state: 'upload'},
      {slot: 'dbs',       required: true,  state: 'upload'},
      {slot: 'firstaid',  required: false, state: 'upload'},
      {slot: 'cv',        required: false, state: 'upload'},
    ];
    expect(canSubmitForReview(DOCS)).toBe(false);  // gate: at least 1 REQ still missing

    // Upload each required slot in turn.
    for (const slot of ['sia', 'passport', 'insurance', 'dbs']) {
      api.uploadDoc.mockResolvedValueOnce({} as never);
      await api.uploadDoc({
        slot: slot as never,
        title: slot,
        file_url: `local://pending/${slot}`,
      });
    }
    expect(api.uploadDoc).toHaveBeenCalledTimes(4);

    const DOCS_COMPLETE = DOCS.map(d => d.required ? {...d, state: 'done'} : d);
    expect(canSubmitForReview(DOCS_COMPLETE)).toBe(true);

    api.submit.mockResolvedValueOnce({} as never);
    await api.submit();
    expect(api.submit).toHaveBeenCalled();

    // ── 07 AdminApproval — server moves agent to SUBMITTED → UNDER_REVIEW
    api.getMe.mockResolvedValueOnce(makeMe({
      status: 'SUBMITTED',
      review: [
        {step: 'submit',  state: 'done'},
        {step: 'docs',    state: 'in_progress'},
        {step: 'kyc',     state: 'pending'},
        {step: 'ops',     state: 'pending'},
        {step: 'partner', state: 'pending'},
      ],
    }) as never);
    const submitted = await api.getMe();
    expect(nextStepFor(submitted.data.agent.status)).toBe('AgentAdminApproval');

    // Ops approves in the web console. Next poll sees APPROVED.
    api.getMe.mockResolvedValueOnce(makeMe({
      status: 'APPROVED',
      review: [
        {step: 'submit',  state: 'done'},
        {step: 'docs',    state: 'done'},
        {step: 'kyc',     state: 'done'},
        {step: 'ops',     state: 'done'},
        {step: 'partner', state: 'done'},
      ],
    }) as never);
    const approved = await api.getMe();
    // APPROVED agents now land on the dashboard — deployment checks are
    // per-mission (signed off on dispatch), not a one-time onboarding
    // gate. See agentFlowHelpers.nextStepFor.
    expect(nextStepFor(approved.data.agent.status)).toBe('AgentDashboard');

    // ── 08 DeploymentRequirements — Ops signs off in-person checks,
    //       server flips agent.status to ACTIVE.
    api.getMe.mockResolvedValueOnce(makeMe({
      status: 'ACTIVE',
      deployment: [
        {check_key: 'dress',    state: 'passed'},
        {check_key: 'vehicle',  state: 'passed'},
        {check_key: 'equip',    state: 'passed'},
        {check_key: 'briefing', state: 'passed'},
      ],
    }) as never);
    const active = await api.getMe();
    expect(active.data.deployment.every(d => d.state === 'passed')).toBe(true);
    expect(nextStepFor(active.data.agent.status)).toBe('AgentDashboard');

    // ── 09 AgentDashboard — agent can now toggle duty status ──
    api.setDuty.mockResolvedValueOnce({} as never);
    await api.setDuty(true);
    expect(api.setDuty).toHaveBeenCalledWith(true);

    // Overall call ordering sanity: every mutation fired at least once.
    expect(api.create).toHaveBeenCalled();
    expect(api.updateCompany).toHaveBeenCalled();
    expect(api.startKyc).toHaveBeenCalled();
    expect(api.updateCoverage).toHaveBeenCalled();
    expect(api.updateAvailability).toHaveBeenCalled();
    expect(api.uploadDoc).toHaveBeenCalledTimes(4);
    expect(api.submit).toHaveBeenCalled();
    expect(api.setDuty).toHaveBeenCalled();
  });
});

describe('Agent onboarding smoke — returning user resume logic', () => {
  beforeEach(() => jest.clearAllMocks());

  it('docs-pending agent resumes on AgentDocsUpload when they re-open the app', async () => {
    api.getMe.mockResolvedValueOnce(makeMe({
      status: 'DOCS_PENDING',
      kyc: [
        {kind: 'gov_id',        state: 'done'},
        {kind: 'proof_address', state: 'done'},
        {kind: 'sia_licence',   state: 'done'},
        {kind: 'police',        state: 'done'},
      ],
    }) as never);
    const {data} = await api.getMe();
    expect(nextStepFor(data.agent.status)).toBe('AgentDocsUpload');
    expect(api.create).not.toHaveBeenCalled();   // no double-create
  });

  it('submitted agent resumes on AgentAdminApproval (polling screen)', async () => {
    api.getMe.mockResolvedValueOnce(makeMe({status: 'SUBMITTED'}) as never);
    const {data} = await api.getMe();
    expect(nextStepFor(data.agent.status)).toBe('AgentAdminApproval');
  });

  it('active agent skips onboarding entirely and lands on Dashboard', async () => {
    api.getMe.mockResolvedValueOnce(makeMe({
      status: 'ACTIVE',
      jobs_total: 142, duty_hours_mtd: 134, rating: '4.92', on_duty: true,
    }) as never);
    const {data} = await api.getMe();
    expect(nextStepFor(data.agent.status)).toBe('AgentDashboard');
    expect(data.agent.jobs_total).toBe(142);
  });

  it('rejected agent routes to AgentRejected', async () => {
    api.getMe.mockResolvedValueOnce(makeMe({status: 'REJECTED'}) as never);
    const {data} = await api.getMe();
    expect(nextStepFor(data.agent.status)).toBe('AgentRejected');
  });
});

describe('Agent onboarding smoke — resilience', () => {
  beforeEach(() => jest.clearAllMocks());

  it('handles 409 "already exists" on create by resuming the flow', async () => {
    api.create.mockRejectedValueOnce({response: {status: 409, data: {message: 'Agent already exists'}}});
    try {
      await api.create('cpo');
    } catch (e) {
      // TypeSelect code calls isAlreadyExistsError + navigates forward.
      const {isAlreadyExistsError} = await import('../agentFlowHelpers');
      expect(isAlreadyExistsError(e)).toBe(true);
    }
  });

  it('decodes NestJS array error messages so Alert.alert does not crash', async () => {
    api.updateCompany.mockRejectedValueOnce({
      response: {data: {message: ['email must be valid', 'phone must be E.164']}},
    });
    const {extractMsg} = await import('../agentFlowHelpers');
    try {
      await api.updateCompany({legal_name: '', company_number: ''} as never);
    } catch (e) {
      const body = extractMsg(e);
      expect(typeof body).toBe('string');
      expect(body).toContain('email');
      expect(body).toContain('phone');
    }
  });
});
