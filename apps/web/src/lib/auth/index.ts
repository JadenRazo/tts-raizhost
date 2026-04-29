// Better Auth instance. Lazy-singleton so this module can be imported
// at build-time without DATABASE_URL set.
//
// We don't enable emailAndPassword, magicLink, socialProviders, or any
// built-in primary credential. Authentication happens through the
// totp-primary plugin (see ./plugin.ts), which adds /sign-in/totp,
// /sign-in/recovery, and /enroll/confirm endpoints.

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { env } from "@/lib/env";
import { totpPrimary } from "./plugin";

let _auth: ReturnType<typeof createAuth> | null = null;

function createAuth() {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: env.BETTER_AUTH_TRUSTED_ORIGINS,

    database: drizzleAdapter(getDb(), {
      provider: "pg",
      usePlural: true,
      schema: {
        users: schema.users,
        sessions: schema.sessions,
        accounts: schema.accounts,
        verifications: schema.verifications,
      },
    }),

    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5,
      },
    },

    user: {
      additionalFields: {
        totpSecretEnc: { type: "string", required: false, input: false },
        recoveryCodesEnc: { type: "string", required: false, input: false },
        enrolledAt: { type: "date", required: false, input: false },
        isAdmin: {
          type: "boolean",
          defaultValue: false,
          required: false,
          input: false,
        },
      },
    },

    advanced: {
      cookiePrefix: "tts",
      database: {
        generateId: false,
      },
      defaultCookieAttributes: {
        sameSite: "lax",
        secure: env.IS_PRODUCTION,
        httpOnly: true,
      },
    },

    plugins: [totpPrimary(), nextCookies()],
  });
}

export function getAuth() {
  if (!_auth) {
    _auth = createAuth();
  }
  return _auth;
}

// Lazy proxy so callers can `import { auth }` and call methods without
// triggering env reads at import time.
export const auth = new Proxy({} as ReturnType<typeof createAuth>, {
  get(_target, prop, receiver) {
    return Reflect.get(getAuth(), prop, receiver);
  },
});

export type Session = typeof auth.$Infer.Session;
