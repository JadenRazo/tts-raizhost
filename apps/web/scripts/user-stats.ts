// CLI: print signup stats for tts.raizhost.com.
//
// "User" means an account that completed TOTP enrollment (enrolled_at IS
// NOT NULL). The enroll-confirm endpoint sets enrolled_at in the same
// transaction that mints the first session, so this is the bar for
// "connected 2FA and logged in" — not just "entered an email". Rows
// without enrolled_at are people who started signup but never finished
// the QR step, plus the library@system seed user.
//
// Reads the users + invite_codes tables and surfaces:
//   - total enrolled-user count
//   - enrollments in last 24h / 7d / 30d (by enrolled_at)
//   - pending: invite consumed, never finished 2FA
//   - per-invite-link redemption (use_count / max_uses), sorted by most
//     recently issued
//   - the 10 most recent enrollments (email + age)
//
// Read-only. Safe to run any time.

import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db";

type Totals = {
  total: number;
  last24h: number;
  last7d: number;
  last30d: number;
  pending: number;
};

type InviteRow = {
  code: string;
  notes: string | null;
  use_count: number;
  max_uses: number;
  issued_at: Date | string;
};

type RecentUser = {
  email: string;
  enrolled_at: Date | string;
};

function fmtAge(d: Date | string): string {
  const t = typeof d === "string" ? Date.parse(d) : d.getTime();
  const ms = Date.now() - t;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

async function main() {
  const db = getDb();

  const totalsRow = await db.execute<Totals>(sql`
    select
      count(*) filter (where enrolled_at is not null)::int as total,
      count(*) filter (where enrolled_at > now() - interval '24 hours')::int as last24h,
      count(*) filter (where enrolled_at > now() - interval '7 days')::int as last7d,
      count(*) filter (where enrolled_at > now() - interval '30 days')::int as last30d,
      count(*) filter (where enrolled_at is null and email not like '%@system.tts.raizhost.local')::int as pending
    from users
  `);
  const totals = totalsRow.rows[0]!;

  const invitesRes = await db.execute<InviteRow>(sql`
    select code, notes, use_count, max_uses, issued_at
    from invite_codes
    order by issued_at desc
  `);
  const invites = invitesRes.rows;

  const recentRes = await db.execute<RecentUser>(sql`
    select email, enrolled_at
    from users
    where enrolled_at is not null
    order by enrolled_at desc
    limit 10
  `);
  const recent = recentRes.rows;

  const totalSlots = invites.reduce((a, r) => a + r.max_uses, 0);
  const totalUsed = invites.reduce((a, r) => a + r.use_count, 0);

  console.log("");
  console.log(`tts.raizhost.com — signup stats (2FA-enrolled users only)`);
  console.log(`  total users:    ${totals.total}`);
  console.log(`  last 24h:       +${totals.last24h}`);
  console.log(`  last 7 days:    +${totals.last7d}`);
  console.log(`  last 30 days:   +${totals.last30d}`);
  if (totals.pending > 0) {
    console.log(`  pending 2FA:    ${totals.pending}  (entered email, never enrolled)`);
  }
  console.log("");
  console.log(`invite links (${invites.length} total, ${totalUsed}/${totalSlots} slots consumed)`);
  if (invites.length === 0) {
    console.log("  (none issued yet — run /tts-friend-codes to mint one)");
  } else {
    for (const r of invites) {
      const short = r.code.slice(0, 12) + "…";
      const label = r.notes ? `  ${r.notes}` : "";
      const remaining = r.max_uses - r.use_count;
      const status =
        remaining === 0
          ? "FULL"
          : r.use_count === 0
            ? "unused"
            : `${remaining} left`;
      console.log(
        `  ${short}  ${r.use_count}/${r.max_uses}  (${status})  issued ${fmtAge(r.issued_at)}${label}`,
      );
    }
  }
  console.log("");
  console.log(`recent enrollments (last ${recent.length})`);
  if (recent.length === 0) {
    console.log("  (no enrolled users yet)");
  } else {
    for (const u of recent) {
      console.log(`  ${u.email.padEnd(40)} ${fmtAge(u.enrolled_at)}`);
    }
  }
  console.log("");

  process.exit(0);
}

main().catch((err) => {
  console.error("user-stats failed:", err);
  process.exit(1);
});
