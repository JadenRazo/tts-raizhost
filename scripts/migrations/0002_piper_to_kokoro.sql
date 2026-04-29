-- One-shot data migration: rewrite Piper voice IDs in user_settings to
-- the new Kokoro voice IDs. Run AFTER drizzle-kit generates and applies
-- the schema migration that flips the user_settings.voice_id default to
-- 'af_heart' (auto-produced from apps/web/src/lib/db/schema.ts).
--
-- This file is NOT tracked by drizzle-kit — it's a manual data fixup.
-- Drizzle's tracked schema migrations live in apps/web/drizzle/. Runs
-- exactly once; idempotent (UPDATEs no-op on second run because the
-- rows are already flipped).
--
-- Usage on the VPS (after deploying the new code):
--   docker exec -i shared-postgres psql \
--     -U portfolio_admin -d tts_raizhost \
--     < scripts/migrations/0002_piper_to_kokoro.sql
--
-- Cache note: tts_cache rows are content-addressed by sha256 over
-- (voice|speed|sentenceText). Old Piper-era cache entries become
-- unreachable after this migration; they orphan on disk until the
-- nightly 60-day eviction CronJob (PLAN.md Phase 8) reaps them. No
-- forced cleanup needed.

UPDATE user_settings
SET voice_id = 'af_heart'
WHERE voice_id = 'en_US-lessac-medium';

UPDATE user_settings
SET voice_id = 'am_michael'
WHERE voice_id = 'en_US-ryan-medium';
