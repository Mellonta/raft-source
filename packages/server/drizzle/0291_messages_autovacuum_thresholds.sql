-- Vacuum messages at ~2% change instead of the global 20%.
--
-- Why: with the defaults, messages (≈16M rows, 43 GB heap, 11 GB indexes)
-- needs ≈3.2M dead tuples or ≈3.2M inserts before autovacuum runs; on
-- 2026-09-27 it had not run since 2026-09-23 and would not for weeks. Every
-- page written since the last vacuum is not all-visible, so index-only scans
-- over recent rows fall back to the heap: a count over the newest 500k seq
-- range did 176,443 heap fetches (≈41% of rows). At 0.02 (≈320k dead tuples
-- or inserts, about every 4-5 days at current rates) most of each run is
-- setting visibility-map bits on recent pages.
--
-- Why not lower (e.g. 0.01): once dead tuples are above PostgreSQL's index
-- bypass (≈2% of heap pages), each vacuum scans every index in full, including
-- the 5.7 GB full-text GIN index, and on Neon those are cold page-server reads.
-- 0.02 keeps that cost to a few runs a month.
--
-- Storage parameters only: this does not run VACUUM or touch data. The
-- existing analyze settings from 0181 are unchanged.
ALTER TABLE "messages" SET (
	autovacuum_vacuum_scale_factor = 0.02,
	autovacuum_vacuum_insert_scale_factor = 0.02
);
