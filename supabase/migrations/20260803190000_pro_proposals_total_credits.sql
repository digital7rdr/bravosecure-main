-- Bravo Secure Pro — proposals quote the FULL coverage period, not a monthly
-- rate (founder decision 2026-08-03: "if we have selected 3 months then the
-- proposal covers that full time period, not month-wise"). Activation debits
-- the total once and the plan runs to coverage_end (current_period_end mirrors
-- it); there is no monthly renewal on Pro plans.
--
-- Safe rename: the feature shipped hours ago; the only rows are staging test
-- applications with no proposals attached under the old semantics.

ALTER TABLE public.pro_proposals RENAME COLUMN monthly_credits TO total_credits;

COMMENT ON COLUMN public.pro_proposals.total_credits IS
  'Total Bravo Credits for the WHOLE coverage period (coverage_start → coverage_end). Debited once at activation.';
