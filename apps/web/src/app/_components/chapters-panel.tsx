"use client";

// Chapter / table-of-contents panel.
//
// Renders the outline-extracted chapter list with depth indentation,
// highlights the chapter the active sentence is currently inside,
// and lets the user jump to any chapter. Empty state is rendered
// when the PDF had no usable outline so the user understands why
// (rather than just seeing a missing button).

import type { ReaderChapter } from "@/app/read/[bookId]/reader";

type Props = {
  chapters: ReaderChapter[];
  currentSentenceIdx: number;
  onJump: (sentenceIdx: number) => void;
  onClose: () => void;
};

export function ChaptersPanel({
  chapters,
  currentSentenceIdx,
  onJump,
  onClose,
}: Props) {
  // Determine the active chapter: largest startSentenceIdx <= currentSentenceIdx.
  // Chapters are sorted by `ord` (outline order); we want positional order.
  const positional = [...chapters].sort(
    (a, b) => a.startSentenceIdx - b.startSentenceIdx,
  );
  let activeId: string | null = null;
  for (const c of positional) {
    if (c.startSentenceIdx <= currentSentenceIdx) activeId = c.id;
    else break;
  }

  return (
    <section
      aria-label="Chapters"
      className="rounded-lg border border-border bg-surface p-4"
    >
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-fg">Chapters</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chapters"
          className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg"
        >
          Close
        </button>
      </header>

      {chapters.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          This PDF doesn’t have an outline. Chapter navigation falls
          back to page jumps.
        </p>
      ) : (
        <ul className="mt-3 max-h-[60vh] divide-y divide-border overflow-y-auto">
          {chapters.map((c) => {
            const isActive = c.id === activeId;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onJump(c.startSentenceIdx)}
                  className={`block w-full px-3 py-2 text-left text-sm transition-colors ${
                    isActive
                      ? "bg-surface-2 text-fg"
                      : "text-muted hover:bg-surface-2 hover:text-fg"
                  }`}
                  style={{ paddingLeft: `${0.75 + c.depth * 1}rem` }}
                  aria-current={isActive ? "true" : undefined}
                >
                  <span>{c.title}</span>
                  <span className="ml-2 text-xs text-subtle tabular-nums">
                    · {c.startSentenceIdx + 1}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
