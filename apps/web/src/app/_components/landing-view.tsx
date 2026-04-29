// Unauthenticated landing surface for tts.raizhost.com.
// Server component, no props. Typography-led, grayscale, no hero gradient,
// no three-feature-card row. All colour comes from the design tokens in
// globals.css so it adapts to prefers-color-scheme automatically.

export function LandingView() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-20 sm:py-28">
      <header className="pb-4">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">
          tts.raizhost.com
        </p>
        <h1 className="mt-6 text-balance text-4xl font-semibold leading-[1.1] tracking-tight text-fg sm:text-5xl">
          Read your PDFs out loud, in a voice that doesn&apos;t sound like
          a robot.
        </h1>
        <p className="mt-6 max-w-prose text-base leading-relaxed text-muted">
          Upload a PDF, pick a neural voice, and listen. Position is
          remembered across devices, so the page you stop on at your desk
          is the page that resumes on your phone. Self-hosted, single user
          per account, no third-party speech APIs.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <a
            href="/signup"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
          >
            Get started
          </a>
          <a
            href="/login"
            className="text-sm font-medium text-fg underline underline-offset-4 decoration-border-strong hover:decoration-fg"
          >
            Sign in
          </a>
        </div>
      </header>

      <section className="mt-14">
        <h2 className="text-sm font-medium uppercase tracking-widest text-muted">
          What you get
        </h2>
        <dl className="mt-6 flex flex-col divide-y divide-border border-y border-border">
          <div className="grid gap-2 py-5 sm:grid-cols-[10rem_1fr] sm:gap-6">
            <dt className="text-sm font-medium text-fg">Neural voices</dt>
            <dd className="text-sm leading-relaxed text-muted">
              Kokoro voices rendered server-side and cached as Opus.
              Re-listening costs no GPU time.
            </dd>
          </div>
          <div className="grid gap-2 py-5 sm:grid-cols-[10rem_1fr] sm:gap-6">
            <dt className="text-sm font-medium text-fg">Resumes anywhere</dt>
            <dd className="text-sm leading-relaxed text-muted">
              Your position is written to the server on a one-second
              debounce. Open the same book on any other device and you
              pick up at the sentence you left.
            </dd>
          </div>
          <div className="grid gap-2 py-5 sm:grid-cols-[10rem_1fr] sm:gap-6">
            <dt className="text-sm font-medium text-fg">PDF native</dt>
            <dd className="text-sm leading-relaxed text-muted">
              Sentence-aligned playback with the page rendered above the
              controls. Click a sentence, jump there. Skip headers and
              footnotes automatically.
            </dd>
          </div>
          <div className="grid gap-2 py-5 sm:grid-cols-[10rem_1fr] sm:gap-6">
            <dt className="text-sm font-medium text-fg">Authenticator-only</dt>
            <dd className="text-sm leading-relaxed text-muted">
              No passwords, no email link. Sign in with the 6-digit code
              from any TOTP app &mdash; 1Password, Bitwarden, Aegis,
              Google Authenticator. Eight single-use recovery codes if
              you lose the device.
            </dd>
          </div>
          <div className="grid gap-2 py-5 sm:grid-cols-[10rem_1fr] sm:gap-6">
            <dt className="text-sm font-medium text-fg">Quiet by design</dt>
            <dd className="text-sm leading-relaxed text-muted">
              50&nbsp;MB and five books per account. Enough for what
              you&apos;re actually reading, not enough to host a library.
            </dd>
          </div>
        </dl>
      </section>

      <section className="mt-14">
        <h2 className="text-sm font-medium uppercase tracking-widest text-muted">
          How signup works
        </h2>
        <ol className="mt-6 flex flex-col gap-4 text-sm leading-relaxed text-muted">
          <li className="flex gap-4">
            <span className="font-mono text-xs text-subtle">01</span>
            <span>
              <span className="text-fg">Enter your email.</span> No password,
              and we never send mail &mdash; it&apos;s just your login handle.
            </span>
          </li>
          <li className="flex gap-4">
            <span className="font-mono text-xs text-subtle">02</span>
            <span>
              <span className="text-fg">Scan a QR code</span> with your
              authenticator app and save the eight recovery codes
              somewhere safe.
            </span>
          </li>
          <li className="flex gap-4">
            <span className="font-mono text-xs text-subtle">03</span>
            <span>
              <span className="text-fg">Confirm the current code</span>{" "}
              once and you&apos;re in. Every future sign-in is the same
              six digits.
            </span>
          </li>
        </ol>
        <div className="mt-8">
          <a
            href="/signup"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
          >
            Create an account
          </a>
        </div>
      </section>

      <footer className="mt-20 border-t border-border pt-6 text-xs text-subtle">
        Run by RaizHost. Source on github.com/JadenRazo.
      </footer>
    </main>
  );
}
