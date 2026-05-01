"use client";

// Sleep timer button + popover.
//
// Compact closed state: a moon icon. When active, also shows the
// remaining time (e.g. "28:45"). Click to toggle the popover; click
// outside to dismiss. Selecting an option closes the popover.
//
// The actual fade / pause / state is in the reader — this component
// is just the picker UI.

import { useEffect, useRef, useState } from "react";

import {
  DURATION_OPTIONS_MINUTES,
  formatRemaining,
} from "@/lib/sleep-timer";

type Props = {
  /** Remaining time in milliseconds when a duration timer is active; null
   *  when off or in end-of-page mode. */
  remainingMs: number | null;
  /** True when the end-of-page mode is armed (pauses at next page break). */
  endOfPageActive: boolean;
  /** Default duration to highlight when the popover opens. */
  defaultMinutes: number;
  /** Start a duration-based timer for `minutes`. */
  onStart: (minutes: number) => void;
  /** Arm end-of-page mode — pause when the current page ends. */
  onStartEndOfPage: () => void;
  /** Cancel any active timer. */
  onCancel: () => void;
  /** Add 5 minutes to the active duration timer (no-op for end-of-page). */
  onExtend: () => void;
};

export function SleepTimerControl({
  remainingMs,
  endOfPageActive,
  defaultMinutes,
  onStart,
  onStartEndOfPage,
  onCancel,
  onExtend,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      if (e.target instanceof Node && wrapper.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const durationActive = remainingMs !== null && remainingMs > 0;
  const active = durationActive || endOfPageActive;
  const buttonTitle = durationActive
    ? `Sleep in ${formatRemaining(remainingMs)}`
    : endOfPageActive
      ? "Sleep at end of page"
      : "Sleep timer";

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={active ? "Sleep timer (active)" : "Sleep timer"}
        aria-expanded={open}
        title={buttonTitle}
        className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-sm transition-colors ${
          active
            ? "border-accent bg-accent-soft text-fg"
            : "border-border text-fg hover:bg-surface-2"
        }`}
      >
        <span aria-hidden>☾</span>
        {durationActive ? (
          <span className="text-xs tabular-nums">
            {formatRemaining(remainingMs)}
          </span>
        ) : endOfPageActive ? (
          <span className="text-xs">EoP</span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Sleep timer options"
          className="absolute right-0 top-full z-10 mt-2 w-56 rounded-lg border border-border bg-surface p-3 shadow-lg"
        >
          <p className="mb-2 text-xs text-muted">Pause after…</p>
          <div className="grid grid-cols-2 gap-1">
            {DURATION_OPTIONS_MINUTES.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  onStart(m);
                  setOpen(false);
                }}
                className={`rounded-md border px-2 py-1.5 text-xs ${
                  m === defaultMinutes
                    ? "border-accent text-fg"
                    : "border-border text-muted hover:bg-surface-2 hover:text-fg"
                }`}
              >
                {m} min
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              onStartEndOfPage();
              setOpen(false);
            }}
            className={`mt-1 w-full rounded-md border px-2 py-1.5 text-xs ${
              endOfPageActive
                ? "border-accent text-fg"
                : "border-border text-muted hover:bg-surface-2 hover:text-fg"
            }`}
          >
            End of page
          </button>
          <button
            type="button"
            onClick={() => {
              if (active) onCancel();
              setOpen(false);
            }}
            title="Never auto-pause — keep reading"
            className={`mt-1 w-full rounded-md border px-2 py-1.5 text-xs ${
              !active
                ? "border-accent text-fg"
                : "border-border text-muted hover:bg-surface-2 hover:text-fg"
            }`}
          >
            Never (keep reading)
          </button>
          {active ? (
            <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
              {durationActive ? (
                <button
                  type="button"
                  onClick={() => {
                    onExtend();
                  }}
                  className="flex-1 rounded-md border border-border px-2 py-1.5 text-xs text-fg hover:bg-surface-2"
                >
                  +5 min
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  onCancel();
                  setOpen(false);
                }}
                className="flex-1 rounded-md border border-border px-2 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
              >
                Cancel
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
