import { RecoverForm } from "./recover-form";

export default function RecoverPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Recover access
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        Enter your email and one of the recovery codes you saved at
        enrollment. The code is single-use; after submission you&apos;ll
        be sent through enrollment again to set up a new authenticator.
      </p>
      <div className="mt-8">
        <RecoverForm />
      </div>
      <p className="mt-10 text-sm text-muted">
        Remembered your authenticator?{" "}
        <a href="/login" className="font-medium text-fg underline underline-offset-4 decoration-border-strong hover:decoration-fg">
          Sign in
        </a>
        .
      </p>
    </main>
  );
}
