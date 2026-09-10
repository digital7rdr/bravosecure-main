-- Issue 30 (Testing Issues V2, PDF p.35) — "Client Is Not Shown the Assigned
-- Vehicle and Registration Number".
--
-- vehicle_pool already carries call_sign / make_model / plate, but NOT colour —
-- and colour is the single most useful field when a principal is standing on a
-- kerb trying to identify an arriving car. The PDF asks for make, model, colour
-- and registration together.
--
-- Nullable with no default: an unset colour renders as omitted rather than as a
-- wrong one. Seeding real values is an ops task.

ALTER TABLE vehicle_pool
  ADD COLUMN IF NOT EXISTS colour TEXT;

COMMENT ON COLUMN vehicle_pool.colour IS
  'Vehicle colour shown to the client for kerbside identification, e.g. "Black" (Issue 30). NULL = not recorded; the client card omits it rather than guessing.';
