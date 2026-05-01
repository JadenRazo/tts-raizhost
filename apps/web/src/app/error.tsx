"use client";

// Next.js per-segment error boundary. Catches React render-tree
// exceptions that escape page components and would otherwise show the
// dev-mode red screen. Reports to RUM as `js_error` and gives the user
// a Try-again button instead of a white screen.

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { rum } from "@/lib/rum";

const ROUTE_TEMPLATES: Array<[RegExp, string]> = [
  [/^\/$/, "/"],
  [/^\/login$/, "/login"],
  [/^\/signup$/, "/signup"],
  [/^\/upload$/, "/upload"],
  [/^\/recover$/, "/recover"],
  [/^\/read\/[^/]+$/, "/read/[bookId]"],
  [/^\/enroll\/[^/]+$/, "/enroll/[token]"],
];
function templateOf(pathname: string | null): string {
  if (!pathname) return "unknown";
  for (const [rx, t] of ROUTE_TEMPLATES) if (rx.test(pathname)) return t;
  return "other";
}

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const pathname = usePathname();
  useEffect(() => {
    rum.error(error, {
      route: templateOf(pathname),
      source: "error-boundary",
    });
  }, [error, pathname]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Something broke
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        The page hit an unexpected error. The owner has been notified through
        telemetry. You can try again, or head back to the library.
      </p>
      {error.digest ? (
        <p className="mt-3 font-mono text-xs text-subtle">
          ref: {error.digest}
        </p>
      ) : null}
      <div className="mt-8 flex items-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
        >
          Try again
        </button>
        <a
          href="/"
          className="text-sm text-muted underline-offset-4 hover:text-fg hover:underline"
        >
          Library
        </a>
      </div>
    </main>
  );
}
