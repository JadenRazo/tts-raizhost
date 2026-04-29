"use client";

import { useState, type FormEvent } from "react";

export function EnrollForm({ token }: { token: string }) {
  const [code, setCode] = useState("");
  const [acked, setAcked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!acked) {
      setError("Please confirm you saved your recovery codes.");
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/auth/enroll/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, code, codesAcknowledged: acked }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string }
          | null;
        setError(body?.message ?? "Could not confirm.");
        return;
      }
      window.location.href = "/";
    } catch {
      setError("Network error. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-fg">6-digit code</span>
        <input
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          autoComplete="one-time-code"
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          maxLength={6}
          className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-base tracking-widest text-fg placeholder:text-subtle focus:border-border-strong"
        />
      </label>
      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={acked}
          onChange={(e) => setAcked(e.target.checked)}
          className="mt-1 accent-accent"
        />
        <span>I&apos;ve saved my recovery codes somewhere safe.</span>
      </label>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="mt-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-50"
      >
        {pending ? "Confirming…" : "Confirm and sign in"}
      </button>
    </form>
  );
}
