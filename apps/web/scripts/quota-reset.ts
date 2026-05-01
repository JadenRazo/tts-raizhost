// CronJob entrypoint: reset daily TTS quotas at 00:00 UTC. Idempotent
// against a doubly-fired Job — the underlying SQL only resets rows whose
// last_reset_at is older than 20 hours.

import { getDb } from "../src/lib/db";
import { resetAllDailyQuotas } from "../src/lib/tts-quota";

async function main() {
  const db = getDb();
  const reset = await resetAllDailyQuotas(db);
  console.log(JSON.stringify({ ok: true, reset }));
  process.exit(0);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});
