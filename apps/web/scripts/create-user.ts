// CLI: create a user account and print a one-time enrollment URL.
//
// Open self-signup is the primary path; this script is kept for two cases:
//   1. Bootstrapping the first admin account before signup is exposed.
//   2. Re-issuing an enrollment URL for a known account out-of-band.
//
// Usage:
//   npm run create-user -- --email you@example.com
//   npm run create-user -- --email admin@example.com --admin
//
// The user row is created with totp_secret_enc=NULL; the user must walk
// the enrollment URL within 24 hours to set up their authenticator.

import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db";
import * as schema from "../src/lib/db/schema";
import { env } from "../src/lib/env";

type Args = {
  email: string;
  admin: boolean;
};

const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

function parseArgs(argv: string[]): Args {
  const args: Args = { email: "", admin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--email" || a === "-e") {
      args.email = (argv[++i] ?? "").trim().toLowerCase();
    } else if (a === "--admin") {
      args.admin = true;
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: create-user --email <addr> [--admin]");
      process.exit(0);
    }
  }
  if (!args.email) {
    console.error(
      "error: --email is required\n\nUsage: create-user --email <addr> [--admin]",
    );
    process.exit(1);
  }
  if (!EMAIL_RE.test(args.email) || args.email.length > 254) {
    console.error("error: --email must be a valid address (≤254 chars)");
    process.exit(1);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();

  const existing = await db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${args.email}`);
  if (existing.length > 0) {
    console.error(
      `error: user "${existing[0].email}" already exists (id=${existing[0].id})`,
    );
    process.exit(1);
  }

  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const result = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(schema.users)
      .values({
        email: args.email,
        name: args.email,
        emailVerified: false,
        isAdmin: args.admin,
      })
      .returning({ id: schema.users.id });

    await tx.insert(schema.enrollmentTokens).values({
      token,
      userId: user.id,
      expiresAt,
    });

    return user;
  });

  const url = `${env.PUBLIC_BASE_URL}/enroll/${token}`;

  console.log("");
  console.log("user created");
  console.log("  id:      " + result.id);
  console.log("  email:   " + args.email);
  if (args.admin) console.log("  admin:   yes");
  console.log("  expires: " + expiresAt.toISOString());
  console.log("");
  console.log("send this URL to the user (single-use, 24h TTL):");
  console.log("");
  console.log("  " + url);
  console.log("");

  process.exit(0);
}

main().catch((err) => {
  console.error("create-user failed:", err);
  process.exit(1);
});
