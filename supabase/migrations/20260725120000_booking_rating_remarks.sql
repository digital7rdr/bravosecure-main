-- Issue 31 (Testing Issues V2, PDF p.36) — "Post-Mission Rating Does Not Allow
-- Written Remarks".
--
-- lite_bookings.rating (INTEGER) was the only thing persisted. The API already
-- ACCEPTED `tags` (SubmitRatingDto) but the service never wrote them, so the
-- preset feedback the client picked was silently discarded too. Add both, and
-- the free-text remarks the PDF asks for.
--
-- rating_remarks is client-authored free text: it is exposed only to authorised
-- quality/operational roles, never back to the provider or to another client.

ALTER TABLE lite_bookings
  ADD COLUMN IF NOT EXISTS rating_tags    TEXT[],
  ADD COLUMN IF NOT EXISTS rating_remarks TEXT;

-- Length is enforced at the API boundary (SubmitRatingDto @MaxLength(500)); the
-- CHECK is defence in depth against a direct write. NOT VALID so the statement
-- cannot fail on any pre-existing row (there are none — the column is new).
ALTER TABLE lite_bookings
  DROP CONSTRAINT IF EXISTS lite_bookings_rating_remarks_len;
ALTER TABLE lite_bookings
  ADD CONSTRAINT lite_bookings_rating_remarks_len
  CHECK (rating_remarks IS NULL OR char_length(rating_remarks) <= 500) NOT VALID;

COMMENT ON COLUMN lite_bookings.rating_tags IS
  'Preset feedback chips chosen by the client at rating time (Issue 31).';
COMMENT ON COLUMN lite_bookings.rating_remarks IS
  'Client free-text remarks, max 500 chars. Authorised quality/ops roles only — never surfaced to the provider (Issue 31).';
