-- RS-13 — Normalize cpo_pool.role display-label casing ('cpo' -> 'CPO').
-- cpo_pool.role is a free-text DISPLAY label, not an authz role. It is
-- intentionally open-ended (values like 'Senior CPO · Armed'), so NO CHECK
-- constraint is added — only the 4 lowercase 'cpo' rows are case-normalized so
-- that `role === 'CPO'` comparisons stop silently missing them.
--
-- Note: the 16/44 cpo_pool rows whose id has no matching users.id are
-- roster-only seed data and are intentionally left untouched (not deleted).

UPDATE public.cpo_pool
   SET role = 'CPO'
 WHERE role = 'cpo';

-- Down: no-op (case-normalization is not reversibly meaningful).
