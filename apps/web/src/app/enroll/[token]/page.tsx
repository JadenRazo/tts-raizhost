// Enrollment page. The admin's create-user script issues an enrollment
// token; the user opens this URL once, scans the QR with their authenticator
// app, saves the recovery codes, and submits the current TOTP code to commit.
//
// On every render we generate a fresh TOTP secret + recovery codes and
// upsert them into the verifications table keyed by `enroll:<token>`. The
// previous pending state (if any) is overwritten — refresh = new secret.
// The submit handler in /api/auth/enroll/confirm validates against this
// pending state, encrypts and commits to the user, then mints a session.

import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import QRCode from "qrcode";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  generateTotpSecret,
} from "@/lib/auth/totp";
import {
  generateRecoveryCodes,
} from "@/lib/auth/recovery";
import { EnrollForm } from "./enroll-form";

export const dynamic = "force-dynamic";

const PENDING_TTL_MS = 15 * 60 * 1000;

type PageProps = {
  params: Promise<{ token: string }>;
};

export default async function EnrollPage({ params }: PageProps) {
  const { token } = await params;
  const db = getDb();

  const enroll = await db
    .select()
    .from(schema.enrollmentTokens)
    .where(eq(schema.enrollmentTokens.token, token))
    .limit(1)
    .then((r) => r[0]);

  if (!enroll || enroll.usedAt || enroll.expiresAt < new Date()) {
    notFound();
  }

  const user = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, enroll.userId))
    .limit(1)
    .then((r) => r[0]);

  if (!user) {
    notFound();
  }

  const { base32, otpauthUrl } = generateTotpSecret();
  const { plain, hashes } = generateRecoveryCodes();

  // Upsert pending state. Identifier is unique-per-token; if a row already
  // exists from a prior visit, replace it.
  const identifier = `enroll:${token}`;
  const pendingValue = JSON.stringify({ secret: base32, codeHashes: hashes });
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS);

  await db.transaction(async (tx) => {
    await tx
      .delete(schema.verifications)
      .where(eq(schema.verifications.identifier, identifier));
    await tx.insert(schema.verifications).values({
      identifier,
      value: pendingValue,
      expiresAt,
    });
  });

  const otpauth = otpauthUrl(user.email);
  const qrDataUrl = await QRCode.toDataURL(otpauth, {
    margin: 1,
    width: 256,
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Set up your authenticator
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        Welcome, {user.email}. Scan this QR code in
        any authenticator app (1Password, Bitwarden, Aegis, Google
        Authenticator), save the recovery codes below, and confirm with
        the current 6-digit code.
      </p>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-muted">
          1. Scan with your authenticator
        </h2>
        <div className="mt-3 inline-block rounded-md border border-border-strong bg-white p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qrDataUrl}
            alt="TOTP QR code"
            width={256}
            height={256}
          />
        </div>
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer hover:text-fg">
            Can&apos;t scan? Show the secret manually.
          </summary>
          <code className="mt-2 block rounded border border-border bg-surface-2 p-2 font-mono text-fg break-all">
            {base32}
          </code>
        </details>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-muted">
          2. Save these recovery codes
        </h2>
        <p className="mt-2 text-xs text-muted">
          You&apos;ll see these once. Each works exactly once if you lose
          your authenticator. Store them in a password manager or print
          them.
        </p>
        <ul className="mt-3 grid grid-cols-2 gap-2 rounded-md border border-border bg-surface p-3 font-mono text-sm text-fg">
          {plain.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-muted">
          3. Confirm with the current code
        </h2>
        <div className="mt-3">
          <EnrollForm token={token} />
        </div>
      </section>
    </main>
  );
}
