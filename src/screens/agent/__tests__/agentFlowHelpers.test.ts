import {
  nextStepFor,
  prevStepFor,
  rejectedBackAction,
  mapStepState,
  subLabelFor,
  extractMsg,
  isAlreadyExistsError,
  pickInitials,
  uiTypeToBackend,
  canSubmitForReview,
  docsProgress,
  coverageCountriesPayload,
} from '../agentFlowHelpers';

// ─── nextStepFor — the 9-stage resume map ────────────────────────

describe('nextStepFor', () => {
  it.each([
    ['DRAFT',            'AgentRegistrationWizard'],
    // KYC is folded into the compliance pack (`AgentCoverage` is the
    // next live screen) — see agent.service.ts:skipKycToDocs.
    ['PROFILE_COMPLETE', 'AgentCoverage'],
    ['KYC_PENDING',      'AgentCoverage'],
    ['DOCS_PENDING',     'AgentDocsUpload'],
    ['SUBMITTED',        'AgentAdminApproval'],
    ['UNDER_REVIEW',     'AgentAdminApproval'],
    // Deployment checks are PER-MISSION now (not a one-time onboarding
    // gate) — approved agents land on the dashboard and only see
    // AgentDeploymentRequirements when ops dispatches them on a job.
    ['APPROVED',         'AgentDashboard'],
    ['ACTIVE',           'AgentDashboard'],
    ['REJECTED',         'AgentRejected'],
  ] as const)('%s → %s', (status, expected) => {
    expect(nextStepFor(status)).toBe(expected);
  });

  it('returns null for unknown/empty status so caller stays put', () => {
    expect(nextStepFor('')).toBeNull();
    expect(nextStepFor('SOMETHING_NEW')).toBeNull();
    expect(nextStepFor('draft')).toBeNull(); // case-sensitive
  });
});

// ─── mapStepState — review-pipeline state normalisation ──────────

describe('mapStepState', () => {
  it.each([
    ['done',        'done'],
    ['in_progress', 'inprog'],
    ['rejected',    'rejected'],
    ['pending',     'pending'],
    ['',            'pending'],
    ['unknown',     'pending'],
    ['IN_PROGRESS', 'pending'], // case-sensitive
  ] as const)('%s → %s', (input, expected) => {
    expect(mapStepState(input)).toBe(expected);
  });
});

// ─── subLabelFor — KYC status copy ───────────────────────────────

describe('subLabelFor', () => {
  it('returns verbose copy for each known KYC state', () => {
    expect(subLabelFor('done')).toBe('Verified');
    expect(subLabelFor('running')).toMatch(/Running/);
    expect(subLabelFor('queued')).toBe('Queued');
    expect(subLabelFor('failed')).toMatch(/Failed/);
  });
  it('echoes the raw state for unknown inputs (no crash)', () => {
    expect(subLabelFor('weird_state')).toBe('weird_state');
    expect(subLabelFor('')).toBe('');
  });
});

// ─── extractMsg — server error normalisation (class-validator,
//                  plain string, non-string, network error) ──────

describe('extractMsg', () => {
  it('pulls string message from axios response body', () => {
    const err = {response: {data: {message: 'role must be corporate'}}};
    expect(extractMsg(err)).toBe('role must be corporate');
  });

  it('joins class-validator array messages with separator', () => {
    const err = {response: {data: {message: ['email must be valid', 'password too short']}}};
    expect(extractMsg(err)).toBe('email must be valid · password too short');
  });

  it('stringifies numeric messages (some proxies return numbers)', () => {
    const err = {response: {data: {message: 404}}};
    expect(extractMsg(err)).toBe('404');
  });

  it('falls back to Error.message when no response body', () => {
    const err = new Error('Network Error');
    expect(extractMsg(err)).toBe('Network Error');
  });

  it('returns "Unknown error" for completely opaque errors', () => {
    expect(extractMsg({})).toBe('Unknown error');
    expect(extractMsg(undefined)).toBe('Unknown error');
    expect(extractMsg(null)).toBe('Unknown error');
  });

  it('prefers response.message over Error.message', () => {
    const err = Object.assign(new Error('fallback'), {
      response: {data: {message: 'server says no'}},
    });
    expect(extractMsg(err)).toBe('server says no');
  });
});

// ─── isAlreadyExistsError ────────────────────────────────────────

describe('isAlreadyExistsError', () => {
  it('true on 409 status', () => {
    expect(isAlreadyExistsError({response: {status: 409}})).toBe(true);
  });
  it('true when message contains "already exists" (case-insensitive)', () => {
    expect(isAlreadyExistsError({response: {data: {message: 'Agent already exists'}}})).toBe(true);
    expect(isAlreadyExistsError({response: {data: {message: 'already EXISTS!'}}})).toBe(true);
  });
  it('false for other errors', () => {
    expect(isAlreadyExistsError({response: {status: 400, data: {message: 'bad'}}})).toBe(false);
    expect(isAlreadyExistsError(new Error('timeout'))).toBe(false);
  });
});

// ─── pickInitials — avatar text ──────────────────────────────────

describe('pickInitials', () => {
  it.each([
    // B-90 T-10 spec: 1 word → first 2 letters; 2 words → 2 initials;
    // 3+ words → the FIRST THREE words' initials (never more than 3).
    ['Marcus Thornton',       'MT'],
    ['marcus thornton',       'MT'],
    ['R. Al-Rashid',          'RA'],  // "R." + "Al-Rashid" — first char of each
    ['Madonna',               'MA'],
    ['Ariful',                'AR'],
    ['Ariful Islam',          'AI'],
    ['Ariful Islam Shanto',   'AIS'],
    ['A B C D',               'ABC'], // 4+ words still cap at first 3
    ['A B C D E',             'ABC'],
    ['  John   Doe  ',        'JD'],  // trims + collapses whitespace
    ['',                      'AG'],  // default fallback
    [null,                    'AG'],
    [undefined,               'AG'],
    ['   ',                   'AG'],
  ] as const)('%j → %s', (input, expected) => {
    expect(pickInitials(input)).toBe(expected);
  });
});

// ─── uiTypeToBackend ─────────────────────────────────────────────

describe('uiTypeToBackend', () => {
  it('individual → cpo', () => expect(uiTypeToBackend('individual')).toBe('cpo'));
  it('agency → company',    () => expect(uiTypeToBackend('agency')).toBe('company'));
});

// ─── canSubmitForReview ──────────────────────────────────────────

describe('canSubmitForReview', () => {
  const REQ_ALL_DONE = [
    {slot: 'sia',       required: true,  state: 'done'},
    {slot: 'passport',  required: true,  state: 'done'},
    {slot: 'insurance', required: true,  state: 'done'},
    {slot: 'dbs',       required: true,  state: 'done'},
    {slot: 'firstaid',  required: false, state: 'upload'},
    {slot: 'cv',        required: false, state: 'upload'},
  ];

  it('true when every REQ doc is done (optionals can stay unuploaded)', () => {
    expect(canSubmitForReview(REQ_ALL_DONE)).toBe(true);
  });

  it('false when any required doc is still uploaded / rejected', () => {
    const docs = [...REQ_ALL_DONE];
    docs[0] = {...docs[0], state: 'upload'};
    expect(canSubmitForReview(docs)).toBe(false);
  });

  it('false on empty list (no docs configured)', () => {
    expect(canSubmitForReview([])).toBe(false);
  });

  it('false when all docs are optional and none are done', () => {
    expect(canSubmitForReview([
      {slot: 'cv', required: false, state: 'upload'},
    ])).toBe(false);
  });
});

// ─── docsProgress ────────────────────────────────────────────────

describe('docsProgress', () => {
  it('counts done vs total', () => {
    expect(docsProgress([
      {state: 'done'}, {state: 'done'}, {state: 'upload'},
    ])).toEqual({done: 2, total: 3});
  });
  it('empty → 0/0', () => {
    expect(docsProgress([])).toEqual({done: 0, total: 0});
  });
});

// ─── coverageCountriesPayload ────────────────────────────────────

describe('coverageCountriesPayload', () => {
  it('upper-cases the key and preserves on/off', () => {
    expect(coverageCountriesPayload([
      {key: 'ae', on: true},
      {key: 'sa', on: false},
      {key: 'gb', on: true},
    ])).toEqual([
      {code: 'AE', on: true},
      {code: 'SA', on: false},
      {code: 'GB', on: true},
    ]);
  });
  it('empty in, empty out', () => {
    expect(coverageCountriesPayload([])).toEqual([]);
  });
});

// ─── B-98a — prevStepFor: empty-stack back fallbacks ─────────────

describe('prevStepFor (B-98a wizard back fallback)', () => {
  it.each([
    ['AgentKYC',          'AgentRegistrationWizard'],
    // Coverage's LINEAR predecessor is the registration wizard — the
    // standalone KYC screen is skipped on the linear path.
    ['AgentCoverage',     'AgentRegistrationWizard'],
    ['AgentAvailability', 'AgentCoverage'],
    ['AgentDocsUpload',   'AgentAvailability'],
  ] as const)('%s falls back to %s', (step, prev) => {
    expect(prevStepFor(step)).toBe(prev);
  });

  it.each([
    // Initial route — nothing before it.
    'AgentTypeSelect',
    // Falling back to AgentTypeSelect would bounce off its status
    // auto-forward (replace right back) — chevron is hidden instead.
    'AgentRegistrationWizard',
    // Post-wizard screens manage their own explicit navigation.
    'AgentAdminApproval', 'AgentDeploymentRequirements', 'AgentDashboard', 'AgentRejected',
  ] as const)('%s has no fallback (null)', step => {
    expect(prevStepFor(step)).toBeNull();
  });

  // ─── rejectedBackAction — B-98a on the terminal REJECTED screen ──

  describe('rejectedBackAction', () => {
    it('pops when a route sits behind it (pushed from AgentVerificationStatus)', () => {
      expect(rejectedBackAction(true)).toBe('pop');
    });

    it('signs out when the stack is empty — the replace()/resume entry', () => {
      // AgentRejected is a top-level authed route, so there is no app behind
      // it; sign-out is the only exit that is not a dead no-op.
      expect(rejectedBackAction(false)).toBe('sign-out');
    });

    it('never routes BACK into the wizard — status re-read would bounce straight back', () => {
      // Guards the regression where someone "fixes" the dead chevron by giving
      // AgentRejected a wizard fallback: those screens replace() forward on
      // REJECTED, so the user would ping-pong forever.
      expect(prevStepFor('AgentRejected')).toBeNull();
    });
  });

  it('every resume target nextStepFor can emit either pops or has a fallback/hidden chevron', () => {
    // The resume path replaces the stack down to ONE route; each such
    // landing must not strand the user: either prevStepFor provides a
    // fallback, or the screen is a root/terminal (Dashboard, Rejected,
    // AdminApproval have explicit controls) or hides the chevron (Wizard).
    const resumeTargets = ['AgentRegistrationWizard', 'AgentCoverage', 'AgentDocsUpload',
      'AgentAdminApproval', 'AgentDashboard', 'AgentRejected'] as const;
    const handled = new Set(['AgentRegistrationWizard', 'AgentAdminApproval', 'AgentDashboard', 'AgentRejected']);
    for (const target of resumeTargets) {
      if (!handled.has(target)) {
        expect(prevStepFor(target)).not.toBeNull();
      }
    }
  });
});
