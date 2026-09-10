/**
 * Pure helpers for the Agent Portal onboarding flow.
 *
 * Everything here is side-effect-free and unit-testable. The 9 screens
 * import from this module so business rules (status → next screen,
 * server state → UI state, error extraction) have a single source of
 * truth — and a single Jest spec.
 */

import type {AgentPortalStatus} from '@services/api';

// ─── Server status → which screen the agent should be on ──────────

export type AgentScreenKey =
  | 'AgentTypeSelect'
  | 'AgentRegistrationWizard'
  | 'AgentKYC'
  | 'AgentCoverage'
  | 'AgentAvailability'
  | 'AgentDocsUpload'
  | 'AgentAdminApproval'
  | 'AgentDeploymentRequirements'
  | 'AgentDashboard'
  | 'AgentRejected';

/**
 * Map server-side `agent.status` to the screen that user should resume
 * on. Returning `null` means "stay on the current screen" (e.g., brand
 * new user on AgentTypeSelect before any row exists).
 */
export function nextStepFor(status: AgentPortalStatus | string): AgentScreenKey | null {
  switch (status) {
    case 'DRAFT':            return 'AgentRegistrationWizard';
    // KYC is collected as part of the compliance pack — skip the
    // standalone KYC screen.
    case 'PROFILE_COMPLETE': return 'AgentCoverage';
    case 'KYC_PENDING':      return 'AgentCoverage';
    case 'DOCS_PENDING':     return 'AgentDocsUpload';
    case 'SUBMITTED':        return 'AgentAdminApproval';
    case 'UNDER_REVIEW':     return 'AgentAdminApproval';
    case 'APPROVED':         return 'AgentDashboard';
    case 'ACTIVE':           return 'AgentDashboard';
    case 'REJECTED':         return 'AgentRejected';
    default:                 return null;
  }
}

/**
 * B-98a — where a wizard step's BACK falls back to when the stack is empty.
 *
 * The wizard can be ENTERED mid-flow via navigation.replace (the resume
 * jump in AgentTypeSelect, the KYC advance), which leaves nothing behind
 * the current route — a plain goBack() is then a silent release no-op and
 * the header chevron looks dead. Screens use: canGoBack() ? goBack() :
 * replace(prevStepFor(step)).
 *
 * Mirrors the LINEAR forward edges (TypeSelect → RegistrationWizard →
 * Coverage → Availability → DocsUpload), NOT nextStepFor — that maps
 * server STATUS to a resume screen and deliberately skips KYC. Returning
 * null means "no sensible previous step": AgentTypeSelect is the initial
 * route, and AgentRegistrationWizard must NOT fall back to AgentTypeSelect
 * (its status effect auto-forwards straight back — an infinite bounce);
 * callers hide the chevron instead.
 */
export function prevStepFor(step: AgentScreenKey): AgentScreenKey | null {
  switch (step) {
    case 'AgentKYC':          return 'AgentRegistrationWizard';
    case 'AgentCoverage':     return 'AgentRegistrationWizard';
    case 'AgentAvailability': return 'AgentCoverage';
    case 'AgentDocsUpload':   return 'AgentAvailability';
    default:                  return null;
  }
}

/**
 * B-98a (rejected screen) — what BACK does on the terminal REJECTED screen.
 *
 * AgentRejected is entered via replace() (AgentAdminApproval's poll) or as the
 * status resume target, so its stack is normally empty. It is also a TOP-LEVEL
 * authed route (MainNavigator resolveAuthedRoute → agency / cpo-onboarding), so
 * no app sits behind it. Falling back into the wizard is NOT an option: those
 * screens re-read agent.status on mount and would replace straight back here —
 * an infinite bounce — for as long as ops keeps the row REJECTED. The only real
 * exit is signing out; logging back in returns the agent here, which is expected.
 */
export type RejectedBackAction = 'pop' | 'sign-out';

export function rejectedBackAction(canGoBack: boolean): RejectedBackAction {
  return canGoBack ? 'pop' : 'sign-out';
}

// ─── Review-pipeline step states ──────────────────────────────────

export type ReviewStepState = 'done' | 'inprog' | 'pending' | 'rejected';

/** Normalise backend review-step raw state into UI state. */
export function mapStepState(raw: string): ReviewStepState {
  switch (raw) {
    case 'done':        return 'done';
    case 'in_progress': return 'inprog';
    case 'rejected':    return 'rejected';
    default:            return 'pending';
  }
}

// ─── KYC row sub-labels ──────────────────────────────────────────

export function subLabelFor(state: string): string {
  switch (state) {
    case 'done':    return 'Verified';
    case 'running': return 'Running regulator lookup…';
    case 'queued':  return 'Queued';
    case 'failed':  return 'Failed — contact ops';
    default:        return state;
  }
}

// ─── Error extraction (axios + NestJS class-validator) ───────────

/**
 * Nest's class-validator returns `message` as an array of strings.
 * Axios wraps the server body in `e.response.data`. Some backends
 * return a string. Coerce all of them to a single human-readable
 * string so `Alert.alert(title, body)` never explodes.
 */
export function extractMsg(e: unknown): string {
  const raw = (e as {response?: {data?: {message?: unknown}}})?.response?.data?.message;
  if (Array.isArray(raw))        {return raw.map(String).join(' · ');}
  if (typeof raw === 'string')   {return raw;}
  if (typeof raw === 'number' || typeof raw === 'boolean') {return String(raw);}

  const errMsg = (e as {message?: unknown})?.message;
  if (typeof errMsg === 'string') {return errMsg;}
  return 'Unknown error';
}

/**
 * True when a server error means "the row already exists", so the UI
 * can skip the create step and resume on the next screen.
 */
export function isAlreadyExistsError(e: unknown): boolean {
  const msg = extractMsg(e).toLowerCase();
  const status = (e as {response?: {status?: number}})?.response?.status;
  return status === 409 || msg.includes('already exists');
}

// ─── Display helpers ─────────────────────────────────────────────

/**
 * Avatar initials (B-90 T-10 spec): one word → its first two letters
 * ("Ariful" → "AR"); two words → both initials ("Ariful Islam" → "AI");
 * three or more words → the first THREE words' initials, capped at 3
 * ("Ariful Islam Shanto" → "AIS").
 */
export function pickInitials(name: string | null | undefined): string {
  if (!name) {return 'AG';}
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {return 'AG';}
  if (parts.length === 1) {return parts[0].slice(0, 2).toUpperCase();}
  return parts.slice(0, 3).map(p => p[0]).join('').toUpperCase();
}

/** Map UI-facing agent-type choice to the backend enum value. */
export function uiTypeToBackend(ui: 'individual' | 'agency'): 'cpo' | 'company' {
  return ui === 'individual' ? 'cpo' : 'company';
}

// ─── Doc-slot metadata (shared by DocsUpload) ────────────────────

export type DocSlot = 'sia' | 'passport' | 'insurance' | 'dbs' | 'firstaid' | 'cv';

/**
 * Compute the submit-gate for the docs screen:
 *   returns true iff every REQUIRED document is in 'done' state.
 *   `docs` is the minimal shape returned by /agents/me.
 */
export function canSubmitForReview(docs: Array<{slot: string; required: boolean; state: string}>): boolean {
  const required = docs.filter(d => d.required);
  if (required.length === 0) {return false;}
  return required.every(d => d.state === 'done');
}

/** Count done / total for the docs ticker in the UI header. */
export function docsProgress(docs: Array<{state: string}>): {done: number; total: number} {
  return {
    done:  docs.filter(d => d.state === 'done').length,
    total: docs.length,
  };
}

// ─── Coverage mapping ────────────────────────────────────────────

/**
 * Convert the UI's per-country toggles into the `updateCoverage` payload
 * (upper-case country code, preserve on/off).
 */
export function coverageCountriesPayload(
  rows: Array<{key: string; on: boolean}>,
): Array<{code: string; on: boolean}> {
  return rows.map(r => ({code: r.key.toUpperCase(), on: r.on}));
}
