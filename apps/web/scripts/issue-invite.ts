// CLI: mint an invite code and print a signup URL.
//
// Friend-tier beta gate: signup is rejected unless a valid code with
// remaining uses is presented. Use --max-uses N to make the same link
// good for up to N signups (default 1, single-use). The CHECK
// constraint on (use_count <= max_uses) makes redemption race-safe
// even under concurrent signups.
//
// Usage:
//   npm run issue-invite -- --notes "alice"            # single-use
//   npm run issue-invite -- --max-uses 10 --notes f1   # 10-person link

import crypto from "node:crypto";
import { getDb } from "../src/lib/db";
import * as schema from "../src/lib/db/schema";
import { env } from "../src/lib/env";

type Args = {
  notes: string | null;
  issuedBy: string | null;
  maxUses: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { notes: null, issuedBy: null, maxUses: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--notes" || a === "-n") {
      args.notes = (argv[++i] ?? "").trim() || null;
    } else if (a === "--issued-by") {
      args.issuedBy = (argv[++i] ?? "").trim() || null;
    } else if (a === "--max-uses" || a === "-m") {
      const raw = (argv[++i] ?? "").trim();
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 1000) {
        console.error(
          `error: --max-uses must be an integer between 1 and 1000 (got "${raw}")`,
        );
        process.exit(1);
      }
      args.maxUses = n;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: issue-invite [--max-uses N] [--notes <label>] [--issued-by <email>]",
      );
      console.log("");
      console.log(
        "  --max-uses N   how many signups the link allows (default 1)",
      );
      console.log("  --notes        free-text label saved with the row");
      console.log("  --issued-by    your email, saved with the row");
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();

  const code = crypto.randomBytes(24).toString("base64url");

  await db.insert(schema.inviteCodes).values({
    code,
    issuedBy: args.issuedBy,
    notes: args.notes,
    maxUses: args.maxUses,
  });

  const url = `${env.PUBLIC_BASE_URL}/signup?code=${code}`;

  console.log("");
  console.log("invite code minted");
  console.log("  code:      " + code);
  console.log("  max uses:  " + args.maxUses);
  if (args.notes) console.log("  notes:     " + args.notes);
  if (args.issuedBy) console.log("  issued by: " + args.issuedBy);
  console.log("");
  if (args.maxUses === 1) {
    console.log("send this URL to the friend (single-use, no expiry):");
  } else {
    console.log(
      `send this URL to up to ${args.maxUses} friends (shared link, no expiry):`,
    );
  }
  console.log("");
  console.log("  " + url);
  console.log("");

  process.exit(0);
}

main().catch((err) => {
  console.error("issue-invite failed:", err);
  process.exit(1);
});
