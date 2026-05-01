import { sql } from "drizzle-orm";
import { redirect } from "next/navigation";

import { SignupForm } from "./signup-form";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ code?: string }>;
};

async function isInviteValid(code: string): Promise<boolean> {
  if (!code || code.length > 64) return false;
  const db = getDb();
  const rows = await db
    .select({ code: schema.inviteCodes.code })
    .from(schema.inviteCodes)
    .where(
      sql`${schema.inviteCodes.code} = ${code} AND ${schema.inviteCodes.useCount} < ${schema.inviteCodes.maxUses}`,
    )
    .limit(1);
  return rows.length > 0;
}

export default async function SignupPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (session) {
    redirect("/");
  }

  const { code = "" } = await searchParams;
  const inviteCode = code.trim();
  const valid = await isInviteValid(inviteCode);

  if (!valid) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          Invite required
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          tts.raizhost.com is in private beta. Sign-up is by invite link
          only. Ask the owner for one.
        </p>
        <p className="mt-10 text-sm text-muted">
          Already have an account?{" "}
          <a
            href="/login"
            className="font-medium text-fg underline underline-offset-4 decoration-border-strong hover:decoration-fg"
          >
            Sign in
          </a>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Create an account
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        Enter your email. On the next screen you&apos;ll set up an
        authenticator app and save recovery codes &mdash; that&apos;s the
        only credential you&apos;ll use to sign in. We never send mail.
      </p>
      <div className="mt-8">
        <SignupForm inviteCode={inviteCode} />
      </div>
      <p className="mt-10 text-sm text-muted">
        Already have an account?{" "}
        <a
          href="/login"
          className="font-medium text-fg underline underline-offset-4 decoration-border-strong hover:decoration-fg"
        >
          Sign in
        </a>
      </p>
    </main>
  );
}
