-- Analyze messages at ~2% change instead of 5%.
--
-- Why: 0181 set messages to autovacuum_analyze_scale_factor = 0.05 with a
-- 10,000-row threshold, so auto-analyze waits for ≈820k changed rows (16.2M
-- rows, 2026-09-29). At ≈86k changes a day that is one ANALYZE every 9-10
-- days; the last one was 2026-09-22. Message search admission (the corpus-wide
-- text-match cap) plans against the search_vector common-term statistics, so
-- stale statistics shift which queries are admitted. At 0.02 (≈334k changes)
-- ANALYZE runs about every 4 days, the same rhythm as the 0291 vacuum
-- thresholds.
--
-- Cost: ANALYZE reads a fixed-size sample (300 x statistics target rows), not
-- the whole table, so running it more often stays cheap.
--
-- Storage parameters only: this does not run ANALYZE or touch data. The
-- analyze threshold from 0181 and the vacuum settings from 0291 are unchanged.
ALTER TABLE "messages" SET (
	autovacuum_analyze_scale_factor = 0.02
);
