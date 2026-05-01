// Better Auth plugin: TOTP-as-primary credential, email as identifier.
//
// Adds four endpoints under /api/auth:
//   POST /sign-up             — email → enrollment URL
//   POST /sign-in/totp        — email + 6-digit code → session
//   POST /sign-in/recovery    — email + recovery code → fresh enrollment URL
//   POST /enroll/confirm      — enrollment token + 6-digit code → session
//
// Email is the sole login identifier. We never send mail and never verify
// deliverability; the address is just a stable, memorable account handle.
//
// All session minting goes through ctx.context.internalAdapter.createSession +
// setSessionCookie so the resulting session is indistinguishable from any
// other Better Auth session and reads via auth.api.getSession() work normally.

import crypto from "node:crypto";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { APIError } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  verifyTotpToken,
} from "./totp";
import {
  findMatchingCodeIndex,
  generateRecoveryCodes,
  parseHashes,
  serializeHashes,
} from "./recovery";
import { check, checkLogin, resetLogin } from "./rate-limit";

// Email validation. We never send mail and never verify deliverability — the
// address is just an account identifier. Compared case-insensitively via the
// users_email_lower_idx unique index.
//
// The regex is deliberately conservative (RFC 5321-ish, no quoted-locals, no
// IP-literal domains). It's a syntactic gate, not an "is this a real address"
// gate; that conversation never happens because no mail leaves the system.
const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

function validateEmail(raw: string): string | { error: string } {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length < 3 || trimmed.length > 254) {
    return { error: "Email must be 3-254 characters." };
  }
  if (!EMAIL_RE.test(trimmed)) {
    return { error: "Enter a valid email address." };
  }
  // Reject control + bidi + zero-width chars even before the regex would, so
  // logs and any future display surface stay free of spoofing characters.
  if (DISALLOWED_CHARS.test(trimmed)) {
    return { error: "Email contains invalid characters." };
  }
  return trimmed;
}

const DISALLOWED_CHARS = new RegExp(
  "[\\u0000-\\u001f\\u007f\\u202a-\\u202e\\u2066-\\u2069\\u200b-\\u200f\\ufeff]",
  "u",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Read the client IP from the Caddy → Cloudflare proxy chain. Returns null
// when no forwarded header is present so the caller can fail closed instead
// of pooling all anonymous traffic into a single "unknown" rate-limit bucket
// (which would let one attacker DoS the form for everyone).
function getIp(headers: Headers): string | null {
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff;
  return null;
}

// Better Auth's setSessionCookie reads user.name; mirror email into name so
// the cookie payload always has a non-null string without a separate column.
function userForCookie<T extends { email: string; name: string | null }>(u: T) {
  return { ...u, name: u.name ?? u.email };
}

async function findUserByEmail(email: string) {
  const db = getDb();
  const lc = email.trim().toLowerCase();
  // The unique index is on lower(email); using the same expression here gives
  // us one index lookup with constant-time-across-casings semantics.
  const rows = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${lc}`)
    .limit(1);
  return rows[0] ?? null;
}

function genericFailure(): never {
  throw new APIError("UNAUTHORIZED", {
    message: "Invalid email or code",
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const totpPrimary = (): BetterAuthPlugin => ({
  id: "totp-primary",
  endpoints: {
    /**
     * POST /api/auth/sign-up
     * Body: { email }
     * Creates a user row with no TOTP secret, issues a 24h single-use
     * enrollment token, and returns { ok: true, enrollUrl: "/enroll/<token>" }.
     * The browser is expected to redirect there; the existing /enroll/[token]
     * page handles QR + recovery codes + first TOTP confirm.
     */
    signUp: createAuthEndpoint(
      "/sign-up",
      {
        method: "POST",
        body: z.object({
          email: z.string().min(1).max(254),
          inviteCode: z.string().min(1).max(64),
        }),
      },
      async (ctx) => {
        const ip = getIp(ctx.headers ?? new Headers());
        // Fail closed if no proxy header is present — the alternative is to
        // pool every header-stripped request into one bucket and let a single
        // attacker DoS the form for everyone.
        if (!ip) {
          throw new APIError("BAD_REQUEST", {
            message: "Could not determine client address.",
          });
        }

        // 3 signups per IP per 5 minutes. We can't key on email here (caller
        // is anonymous and the email isn't yet validated), so IP-only is the
        // right granularity.
        const limit = check(`signup-ip:${ip}`, 3);
        if (!limit.ok) {
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many signups from this address. Try again later.",
          });
        }

        const validated = validateEmail(ctx.body.email);
        if (typeof validated !== "string") {
          throw new APIError("BAD_REQUEST", { message: validated.error });
        }
        const email = validated;

        const inviteCode = ctx.body.inviteCode.trim();
        if (!inviteCode) {
          throw new APIError("BAD_REQUEST", {
            message: "Invite code is required.",
          });
        }

        const db = getDb();

        // Case-insensitive uniqueness check; the unique index on lower(email)
        // is the backstop, but a friendly 409 reads better than a Postgres
        // error.
        const existing = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(sql`lower(${schema.users.email}) = ${email}`)
          .limit(1);
        if (existing.length > 0) {
          throw new APIError("CONFLICT", {
            message: "An account with that email already exists.",
          });
        }

        const token = crypto.randomBytes(24).toString("base64url");
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        try {
          await db.transaction(async (tx) => {
            // Consume the invite code atomically with user-create.
            // WHERE use_count < max_uses gates redemption; the CHECK
            // constraint on (use_count <= max_uses) protects against a
            // concurrent UPDATE racing past the bound. consumed_*
            // fields are populated only on the FIRST consumer of a
            // multi-use code (COALESCE), so single-use codes keep
            // their existing semantics.
            const consumed = await tx
              .update(schema.inviteCodes)
              .set({
                useCount: sql`${schema.inviteCodes.useCount} + 1`,
                consumedAt: sql`COALESCE(${schema.inviteCodes.consumedAt}, now())`,
                consumedByEmail: sql`COALESCE(${schema.inviteCodes.consumedByEmail}, ${email})`,
              })
              .where(
                sql`${schema.inviteCodes.code} = ${inviteCode} AND ${schema.inviteCodes.useCount} < ${schema.inviteCodes.maxUses}`,
              )
              .returning({ code: schema.inviteCodes.code });

            if (consumed.length === 0) {
              throw new APIError("FORBIDDEN", {
                message: "Invite code is invalid or has no remaining uses.",
              });
            }

            const [created] = await tx
              .insert(schema.users)
              .values({
                email,
                // Better Auth's setSessionCookie path reads `name`. Mirror
                // email so cookie payload is always populated.
                name: email,
              })
              .returning({ id: schema.users.id });

            if (!created) {
              throw new APIError("INTERNAL_SERVER_ERROR", {
                message: "Failed to create account",
              });
            }

            // Pin the first consumer's user_id only — leaves later
            // multi-use redemptions discoverable via the users table
            // by created_at.
            await tx
              .update(schema.inviteCodes)
              .set({
                consumedByUserId: sql`COALESCE(${schema.inviteCodes.consumedByUserId}, ${created.id})`,
              })
              .where(eq(schema.inviteCodes.code, inviteCode));

            await tx.insert(schema.enrollmentTokens).values({
              token,
              userId: created.id,
              expiresAt,
            });
          });
        } catch (e) {
          // Re-throw API errors verbatim so the FORBIDDEN from invite
          // consumption surfaces with its own status/message.
          if (e instanceof APIError) throw e;
          // A racing INSERT could trip the unique index after our pre-check.
          if (
            e instanceof Error &&
            /users_email_lower_idx|duplicate key/i.test(e.message)
          ) {
            throw new APIError("CONFLICT", {
              message: "An account with that email already exists.",
            });
          }
          throw e;
        }

        return ctx.json({ ok: true, enrollUrl: `/enroll/${token}` });
      },
    ),

    /**
     * POST /api/auth/sign-in/totp
     * Body: { email, code }
     * On success: sets session cookie, returns { ok: true, redirect: "/" }
     */
    signInTotp: createAuthEndpoint(
      "/sign-in/totp",
      {
        method: "POST",
        body: z.object({
          email: z.string().min(1).max(254),
          code: z.string().min(6).max(8),
        }),
      },
      async (ctx) => {
        const emailInput = ctx.body.email.trim().toLowerCase();
        const { code } = ctx.body;
        // Login keeps a per-email bucket as the primary shield; if the proxy
        // headers go missing we still want existing users to be able to sign
        // in, so fall back to a shared "no-ip" bucket here. The anonymous-DoS
        // concern only applies to signup, which fails closed.
        const ip = getIp(ctx.headers ?? new Headers()) ?? "no-ip";

        const limit = checkLogin(ip, emailInput);
        if (!limit.ok) {
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many attempts. Try again later.",
          });
        }

        const user = await findUserByEmail(emailInput);
        if (!user || !user.totpSecretEnc || !user.enrolledAt) {
          // constant-time-ish: still do a bcrypt-equivalent op so timing
          // doesn't differentiate "no user" from "wrong code".
          await new Promise((r) => setTimeout(r, 80));
          genericFailure();
        }

        let secretBase32: string;
        try {
          secretBase32 = decryptSecret(user.totpSecretEnc);
        } catch {
          genericFailure();
        }

        if (!verifyTotpToken(code, secretBase32)) {
          genericFailure();
        }

        resetLogin(ip, emailInput);

        const session = await ctx.context.internalAdapter.createSession(
          user.id,
          false,
        );
        if (!session) {
          throw new APIError("INTERNAL_SERVER_ERROR", {
            message: "Failed to create session",
          });
        }
        await setSessionCookie(ctx, { session, user: userForCookie(user) }, false);

        return ctx.json({ ok: true, redirect: "/" });
      },
    ),

    /**
     * POST /api/auth/sign-in/recovery
     * Body: { email, code }
     * On success: marks the recovery code consumed, issues a fresh
     * enrollment token, returns { ok: true, enrollUrl: "/enroll/<token>" }.
     * The user is NOT logged in by recovery alone — they must walk
     * enrollment again to get a working TOTP secret.
     */
    signInRecovery: createAuthEndpoint(
      "/sign-in/recovery",
      {
        method: "POST",
        body: z.object({
          email: z.string().min(1).max(254),
          code: z.string().min(6).max(40),
        }),
      },
      async (ctx) => {
        const emailInput = ctx.body.email.trim().toLowerCase();
        const { code } = ctx.body;
        const ip = getIp(ctx.headers ?? new Headers()) ?? "no-ip";

        const limit = checkLogin(ip, emailInput);
        if (!limit.ok) {
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many attempts. Try again later.",
          });
        }

        const db = getDb();
        const user = await findUserByEmail(emailInput);
        if (!user || !user.recoveryCodesEnc) {
          await new Promise((r) => setTimeout(r, 80));
          genericFailure();
        }

        const hashes = parseHashes(user.recoveryCodesEnc);
        const idx = findMatchingCodeIndex(code, hashes);
        if (idx === -1) {
          genericFailure();
        }

        // Burn the code.
        hashes[idx] = null;

        // Issue a fresh enrollment token (24h) so the user can re-enrol.
        const token = crypto.randomBytes(24).toString("base64url");
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await db.transaction(async (tx) => {
          await tx
            .update(schema.users)
            .set({
              recoveryCodesEnc: serializeHashes(hashes),
              // Clear the existing TOTP secret so it can no longer be used.
              totpSecretEnc: null,
              enrolledAt: null,
              updatedAt: new Date(),
            })
            .where(eq(schema.users.id, user.id));

          await tx.insert(schema.enrollmentTokens).values({
            token,
            userId: user.id,
            expiresAt,
          });
        });

        resetLogin(ip, emailInput);

        return ctx.json({ ok: true, enrollUrl: `/enroll/${token}` });
      },
    ),

    /**
     * POST /api/auth/enroll/confirm
     * Body: { token, code, codesAcknowledged }
     *
     * Two-phase: GET /enroll/<token> renders a server-rendered page that
     * generates a TOTP secret + recovery codes, persists them as a pending
     * verification row keyed by the enrollment token, and shows the user
     * the QR + plain recovery codes. On submit, this endpoint validates
     * the entered TOTP code against the pending secret, then commits to
     * the user row and mints a session.
     */
    enrollConfirm: createAuthEndpoint(
      "/enroll/confirm",
      {
        method: "POST",
        body: z.object({
          token: z.string().min(1),
          code: z.string().min(6).max(8),
          codesAcknowledged: z.boolean(),
        }),
      },
      async (ctx) => {
        const { token, code, codesAcknowledged } = ctx.body;

        if (!codesAcknowledged) {
          throw new APIError("BAD_REQUEST", {
            message: "You must confirm you saved your recovery codes.",
          });
        }

        const db = getDb();
        const enroll = await db
          .select()
          .from(schema.enrollmentTokens)
          .where(eq(schema.enrollmentTokens.token, token))
          .limit(1)
          .then((r) => r[0]);

        if (!enroll || enroll.usedAt || enroll.expiresAt < new Date()) {
          throw new APIError("BAD_REQUEST", {
            message: "Enrollment link is invalid or expired.",
          });
        }

        const pending = await db
          .select()
          .from(schema.verifications)
          .where(
            and(
              eq(schema.verifications.identifier, `enroll:${token}`),
            ),
          )
          .limit(1)
          .then((r) => r[0]);

        if (!pending || pending.expiresAt < new Date()) {
          throw new APIError("BAD_REQUEST", {
            message: "Enrollment session expired. Reload the page to retry.",
          });
        }

        let pendingData: { secret: string; codeHashes: string[] };
        try {
          pendingData = JSON.parse(pending.value);
        } catch {
          throw new APIError("INTERNAL_SERVER_ERROR", {
            message: "Corrupt enrollment state.",
          });
        }

        if (!verifyTotpToken(code, pendingData.secret)) {
          throw new APIError("BAD_REQUEST", {
            message: "That code is incorrect. Try the next one your app shows.",
          });
        }

        const user = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, enroll.userId))
          .limit(1)
          .then((r) => r[0]);

        if (!user) {
          throw new APIError("BAD_REQUEST", {
            message: "Account no longer exists.",
          });
        }

        await db.transaction(async (tx) => {
          await tx
            .update(schema.users)
            .set({
              totpSecretEnc: encryptSecret(pendingData.secret),
              recoveryCodesEnc: serializeHashes(pendingData.codeHashes),
              enrolledAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.users.id, user.id));

          await tx
            .update(schema.enrollmentTokens)
            .set({ usedAt: new Date() })
            .where(eq(schema.enrollmentTokens.token, token));

          await tx
            .delete(schema.verifications)
            .where(eq(schema.verifications.id, pending.id));
        });

        const session = await ctx.context.internalAdapter.createSession(
          user.id,
          false,
        );
        if (!session) {
          throw new APIError("INTERNAL_SERVER_ERROR", {
            message: "Failed to create session",
          });
        }
        await setSessionCookie(ctx, { session, user: userForCookie(user) }, false);

        return ctx.json({ ok: true, redirect: "/" });
      },
    ),
  },
});
