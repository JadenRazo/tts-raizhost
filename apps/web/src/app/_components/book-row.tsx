"use client";

// One row in the library list. Client component because the delete action
// fires a fetch + router.refresh() to reload the parent server component.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Props = {
  id: string;
  title: string;
  author: string | null;
  pageCount: number;
  uploadedAt: string;
  /** Featured (public) books — hide the Delete affordance and the
   * "uploaded N ago" suffix since neither applies to a curated row. */
  readOnly?: boolean;
};

const RELATIVE_THRESHOLDS: { limit: number; divisor: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { limit: 60, divisor: 1, unit: "second" },
  { limit: 60 * 60, divisor: 60, unit: "minute" },
  { limit: 60 * 60 * 24, divisor: 60 * 60, unit: "hour" },
  { limit: 60 * 60 * 24 * 30, divisor: 60 * 60 * 24, unit: "day" },
  { limit: 60 * 60 * 24 * 365, divisor: 60 * 60 * 24 * 30, unit: "month" },
];

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const t of RELATIVE_THRESHOLDS) {
    if (abs < t.limit) {
      return rtf.format(Math.round(seconds / t.divisor), t.unit);
    }
  }
  return rtf.format(Math.round(seconds / (60 * 60 * 24 * 365)), "year");
}

export function BookRow({
  id,
  title,
  author,
  pageCount,
  uploadedAt,
  readOnly = false,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDelete() {
    if (deleting) return;
    if (
      !window.confirm(
        `Delete "${title}"? This removes the file and your reading position.`,
      )
    ) {
      return;
    }
    setError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/books/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(body?.error ?? "Failed to delete");
        return;
      }
      startTransition(() => {
        router.refresh();
      });
    } catch {
      setError("Network error");
    } finally {
      setDeleting(false);
    }
  }

  const busy = deleting || pending;

  return (
    <div className="flex items-start gap-4 px-4 py-4">
      <Link href={`/read/${id}`} className="min-w-0 flex-1 group">
        <p className="truncate text-base font-medium text-fg group-hover:underline underline-offset-4">
          {title}
        </p>
        <p className="mt-1 truncate text-sm text-muted">
          {author ? `${author} · ` : ""}
          {pageCount} {pageCount === 1 ? "page" : "pages"}
          {readOnly ? null : (
            <>
              {" · "}
              <span className="text-subtle">
                uploaded {formatRelative(uploadedAt)}
              </span>
            </>
          )}
        </p>
        {error ? (
          <p role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </Link>
      {readOnly ? null : (
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="text-xs text-subtle underline-offset-4 hover:text-danger hover:underline disabled:opacity-50"
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
      )}
    </div>
  );
}
