// Action enum + dispatcher for hardware media controls.
//
// Why an enum (not booleans / function references):
//   - Persisted to user_settings as text. The enum *is* the wire format.
//   - Lets the UI render a single dropdown ("When the wheel sends Skip
//     Forward, do…") whose option list is the enum's domain.
//   - Lets the dispatcher switch on a single value instead of fanning
//     out per-control logic into the reader's handler closures.
//
// Action surface:
//   nexttrack / previoustrack — bound to nextTrackAction / prevTrackAction
//   seekforward / seekbackward — bound to seekForwardAction / seekBackwardAction
//
// The defaults (next_page / prev_page for the track pair, seek_forward /
// seek_back for the seek pair) match the audiobook conventions iOS users
// already know: CarPlay in audiobook mode routes the wheel skip buttons
// to seekforward(N) / seekbackward(N), so the seek pair maps to the
// expected ±15s. nexttrack / previoustrack tend to come from headset
// taps and CarPlay UI buttons, where "jump a page" is more meaningful
// than "rewind 5 seconds" or "skip one sentence".

export const MEDIA_ACTIONS = [
  "next_sentence",
  "prev_sentence",
  "next_page",
  "prev_page",
  "next_chapter",
  "prev_chapter",
  "seek_forward",
  "seek_back",
  "restart_sentence",
  "restart_book",
] as const;

export type MediaAction = (typeof MEDIA_ACTIONS)[number];

// Subsets that match the DB CHECK constraints in user_settings.
export const NEXT_TRACK_ACTIONS = [
  "next_sentence",
  "next_page",
  "next_chapter",
  "seek_forward",
  "restart_sentence",
] as const satisfies readonly MediaAction[];
export type NextTrackAction = (typeof NEXT_TRACK_ACTIONS)[number];

export const PREV_TRACK_ACTIONS = [
  "prev_sentence",
  "prev_page",
  "prev_chapter",
  "seek_back",
  "restart_sentence",
  "restart_book",
] as const satisfies readonly MediaAction[];
export type PrevTrackAction = (typeof PREV_TRACK_ACTIONS)[number];

export const SEEK_FORWARD_ACTIONS = [
  "seek_forward",
  "next_sentence",
  "next_page",
  "next_chapter",
] as const satisfies readonly MediaAction[];
export type SeekForwardAction = (typeof SEEK_FORWARD_ACTIONS)[number];

export const SEEK_BACKWARD_ACTIONS = [
  "seek_back",
  "prev_sentence",
  "prev_page",
  "prev_chapter",
  "restart_sentence",
] as const satisfies readonly MediaAction[];
export type SeekBackwardAction = (typeof SEEK_BACKWARD_ACTIONS)[number];

export type HardwareControlSettings = {
  nextTrackAction: NextTrackAction;
  prevTrackAction: PrevTrackAction;
  seekForwardAction: SeekForwardAction;
  seekBackwardAction: SeekBackwardAction;
  seekStepSeconds: number;
};

export const DEFAULT_HARDWARE_CONTROLS: HardwareControlSettings = {
  nextTrackAction: "next_page",
  prevTrackAction: "prev_page",
  seekForwardAction: "seek_forward",
  seekBackwardAction: "seek_back",
  seekStepSeconds: 15,
};

// Human-readable labels for the settings UI dropdowns. Keys are MediaAction
// values; values are short label + a one-sentence description.
export const ACTION_LABELS: Record<
  MediaAction,
  { label: string; description: string }
> = {
  next_sentence: {
    label: "Next sentence",
    description: "Skip ahead one sentence.",
  },
  prev_sentence: {
    label: "Previous sentence",
    description: "Go back one sentence (or restart the current one if past 3 seconds in).",
  },
  next_page: {
    label: "Next page",
    description: "Jump to the start of the next page.",
  },
  prev_page: {
    label: "Previous page",
    description: "Jump to the start of the previous page.",
  },
  next_chapter: {
    label: "Next chapter",
    description: "Jump to the start of the next chapter (where chapters are detected).",
  },
  prev_chapter: {
    label: "Previous chapter",
    description: "Jump to the start of the previous chapter.",
  },
  seek_forward: {
    label: "Skip forward (seconds)",
    description: "Move forward by your skip-step amount in the book timeline.",
  },
  seek_back: {
    label: "Skip back (seconds)",
    description: "Move back by your skip-step amount in the book timeline.",
  },
  restart_sentence: {
    label: "Restart sentence",
    description: "Replay the current sentence from the beginning.",
  },
  restart_book: {
    label: "Restart book",
    description: "Jump back to the very beginning of the book.",
  },
};

// Handlers the dispatcher needs from the reader. The reader supplies
// these closures; the dispatcher picks the right one for each action.
export type NavigationHandlers = {
  goNextSentence: () => void;
  goPrevSentence: () => void;
  goNextPage: () => void;
  goPrevPage: () => void;
  goNextChapter: () => void;
  goPrevChapter: () => void;
  /** Positive seconds = forward; negative = back. The reader maps this
   *  through the virtual timeline to (idx, offset). */
  seekByVirtualSeconds: (deltaSeconds: number) => void;
  restartSentence: () => void;
  restartBook: () => void;
};

/** Run the action. `seekStepSeconds` is the user's configured step;
 *  applied with the appropriate sign for `seek_forward` / `seek_back`.
 *  For seek action handlers, callers should prefer the offset CarPlay
 *  passes in (passed via `seekOffsetOverride`) so the OS's preferred
 *  step wins; only fall back to the user's config when the OS doesn't
 *  supply one. */
export function dispatchMediaAction(
  action: MediaAction,
  handlers: NavigationHandlers,
  config: { seekStepSeconds: number; seekOffsetOverride?: number },
): void {
  switch (action) {
    case "next_sentence":
      handlers.goNextSentence();
      return;
    case "prev_sentence":
      handlers.goPrevSentence();
      return;
    case "next_page":
      handlers.goNextPage();
      return;
    case "prev_page":
      handlers.goPrevPage();
      return;
    case "next_chapter":
      handlers.goNextChapter();
      return;
    case "prev_chapter":
      handlers.goPrevChapter();
      return;
    case "seek_forward": {
      const step =
        config.seekOffsetOverride && config.seekOffsetOverride > 0
          ? config.seekOffsetOverride
          : config.seekStepSeconds;
      handlers.seekByVirtualSeconds(step);
      return;
    }
    case "seek_back": {
      const step =
        config.seekOffsetOverride && config.seekOffsetOverride > 0
          ? config.seekOffsetOverride
          : config.seekStepSeconds;
      handlers.seekByVirtualSeconds(-step);
      return;
    }
    case "restart_sentence":
      handlers.restartSentence();
      return;
    case "restart_book":
      handlers.restartBook();
      return;
  }
}
