import {useAuthStore} from '@store/authStore';
import {deriveEntitlements} from '@store/entitlements';

/**
 * M1A (founder) — an Enterprise-tier individual runs the department
 * workspace for their staff; the "CPO" wording belongs to the
 * service-provider tenant, whose screens keep it exactly as today
 * (rule 7: provider untouched). Read at render time — the audience only
 * changes with the signed-in account.
 *
 * Enterprise Dept Channels scope v2, frame A7.3 — "Use Member terminology
 * throughout; remove remaining Employee or CPO labels." The Enterprise branch
 * is now Member. The service-provider branch deliberately still says CPO:
 * rule 7 keeps the provider tenant untouched, and whether an AGENCY's dept-chat
 * staff should also read "Member" is a founder call, not ours to assume.
 * See docs/planning/ENTERPRISE_DEPT_CHANNELS_SCOPE_V2_FIT.md.
 *
 * ⚠️ Callers must RENDER this string, never compare against it. A
 * `deptMemberNoun() === 'Employee'` branch silently took the wrong path the
 * moment this returned 'Member'; `deptNoun.test.ts` now pins that.
 */
export function deptMemberNoun(plural = false): string {
  // Founder QA 2026-08-08 — keyed on the TENANT TYPE, not affiliation. The old
  // `isEnterprise && !isOrgAffiliated` was INVERTED for the people who matter:
  // creating a workspace (or joining one) sets isOrgAffiliated, so the founder
  // and every one of their staff read "CPO" the moment the workspace existed —
  // the only persona who ever saw "Member" was someone with no workspace at
  // all. isWorkspaceTenant is the server-authoritative org-type fact.
  const e = deriveEntitlements(useAuthStore.getState().user);
  if (e.isWorkspaceTenant) {return plural ? 'Members' : 'Member';}
  return plural ? 'CPOs' : 'CPO';
}

/**
 * The noun for org_members rows whose `member_role` is literally `'employee'` —
 * i.e. what `EmployeesScreen` lists, and what its entry CTA points at.
 *
 * NOT interchangeable with `deptMemberNoun`. On a PROVIDER tenant those rows are
 * back-office staff and are explicitly NOT the CPO roster — EmployeesScreen
 * filters `member_role === 'employee'` and buckets CPO/manager separately under
 * "managed from your provider roster — untouched here". Rendering
 * `deptMemberNoun` there titled that screen "CPOs" for an agency: the one roster
 * it does not contain. A7.3 only ever asked for the ENTERPRISE label to change,
 * so the provider branch stays 'Employee'.
 *
 * ⚠️ Do not `.toLowerCase()` the result of either helper at a call site.
 * `deptMemberNoun` can return the acronym 'CPOs' → "cpos". Write copy that reads
 * correctly with the noun as-is.
 */
export function deptEmployeeNoun(plural = false): string {
  // Same tenant-type key as deptMemberNoun (see its comment for the inversion
  // this fixes); providers keep 'Employee' for their back-office rows.
  const e = deriveEntitlements(useAuthStore.getState().user);
  if (e.isWorkspaceTenant) {return plural ? 'Members' : 'Member';}
  return plural ? 'Employees' : 'Employee';
}
