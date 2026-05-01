"use client";

// Slide-out panel listing all bookmarks for the current book.
// Tap a row to seek; long-press / right-click to edit the note.
//
// State lives in the reader (the bookmark list and the persistence
// fetches). This component renders.

import { useState } from "react";

export type BookmarkEntry = {
  id: string;
  sentenceIdx: number;
  note: string | null;
  createdAt: string;
};

type Props = {
  bookmarks: BookmarkEntry[];
  /** Sentence preview lookup so the panel can render a snippet under
   *  each bookmark. Sentences not in the loaded window render only the
   *  idx — that's still useful for navigation. */
  sentenceText: (idx: number) => string | null;
  onJump: (sentenceIdx: number) => void;
  onDelete: (bookmarkId: string) => void;
  onEditNote: (bookmarkId: string, nextNote: string | null) => void;
  onClose: () => void;
};

export function BookmarksPanel({
  bookmarks,
  sentenceText,
  onJump,
  onDelete,
  onEditNote,
  onClose,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState("");

  return (
    <section
      aria-label="Bookmarks"
      className="rounded-lg border border-border bg-surface p-4"
    >
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-fg">Bookmarks</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close bookmarks"
          className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg"
        >
          Close
        </button>
      </header>

      {bookmarks.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          No bookmarks yet. Press <kbd className="rounded bg-surface-2 px-1 py-0.5 text-xs">B</kbd> while reading to save your spot.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {bookmarks.map((b) => {
            const preview = sentenceText(b.sentenceIdx);
            const isEditing = editingId === b.id;
            return (
              <li key={b.id} className="py-2">
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    onClick={() => onJump(b.sentenceIdx)}
                    className="flex-1 rounded-md text-left text-sm text-fg transition-colors hover:bg-surface-2"
                  >
                    <span className="text-xs text-subtle tabular-nums">
                      Sentence {b.sentenceIdx + 1}
                    </span>
                    {preview ? (
                      <span className="ml-2 text-muted">
                        {preview.length > 90
                          ? preview.slice(0, 90) + "…"
                          : preview}
                      </span>
                    ) : null}
                    {b.note ? (
                      <p className="mt-1 text-xs text-muted italic">
                        “{b.note}”
                      </p>
                    ) : null}
                  </button>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(b.id);
                        setDraftNote(b.note ?? "");
                      }}
                      aria-label="Edit note"
                      className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg"
                    >
                      Note
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(b.id)}
                      aria-label="Delete bookmark"
                      className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                {isEditing ? (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="text"
                      value={draftNote}
                      onChange={(e) => setDraftNote(e.target.value)}
                      placeholder="Add a note…"
                      maxLength={500}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          onEditNote(b.id, draftNote.trim() || null);
                          setEditingId(null);
                        } else if (e.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      className="flex-1 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        onEditNote(b.id, draftNote.trim() || null);
                        setEditingId(null);
                      }}
                      className="rounded-md border border-border px-2 py-1 text-xs text-fg hover:bg-surface-2"
                    >
                      Save
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
