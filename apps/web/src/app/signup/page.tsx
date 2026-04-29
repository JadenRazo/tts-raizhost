import { SignupForm } from "./signup-form";
import { getSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SignupPage() {
  const session = await getSession();
  if (session) {
    redirect("/");
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
        <SignupForm />
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
