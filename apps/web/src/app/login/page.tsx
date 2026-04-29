import { LoginForm } from "./login-form";
import { getSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  if (session) {
    redirect("/");
  }
  const sp = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Sign in</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        Enter your email and the current 6-digit code from your
        authenticator app.
      </p>
      <div className="mt-8">
        <LoginForm next={sp.next ?? "/"} />
      </div>
      <p className="mt-10 text-sm text-muted">
        New here?{" "}
        <a href="/signup" className="font-medium text-fg underline underline-offset-4 decoration-border-strong hover:decoration-fg">
          Create an account
        </a>
      </p>
      <p className="mt-3 text-xs text-subtle">
        Lost your authenticator?{" "}
        <a href="/recover" className="underline underline-offset-4 hover:text-fg">
          Recover with a backup code
        </a>
        .
      </p>
    </main>
  );
}
