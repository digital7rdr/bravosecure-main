-- H-1: server-side missed-scan watchdog needs a once-per-silent-window marker.
ALTER TABLE public.vbg_monitoring
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

-- M-10: persist the full assessment shown to the principal, not just the score.
ALTER TABLE public.vbg_sra_snapshots
  ADD COLUMN IF NOT EXISTS region  text,
  ADD COLUMN IF NOT EXISTS context text,
  ADD COLUMN IF NOT EXISTS level   text,
  ADD COLUMN IF NOT EXISTS summary text,
  ADD COLUMN IF NOT EXISTS counts  jsonb;

-- H-1: the watchdog sweep scans active rows by heartbeat age.
CREATE INDEX IF NOT EXISTS idx_vbg_monitoring_active_beat
  ON public.vbg_monitoring (status, last_heartbeat_at);
