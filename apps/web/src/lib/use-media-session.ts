"use client";

// React hook that wires the W3C Media Session API onto whatever <audio>
// element the caller is driving. The hook owns every write to
// `navigator.mediaSession.*` so callers can stay declarative: pass
// metadata + handlers + state and the lock screen / CarPlay / Android
// Auto / Bluetooth headset surfaces stay in sync automatically.
//
// Why a hook (not a class or an effect inline in the reader)?
//   - Multiple effects share the "is the API available?" feature-detect.
//   - Action handlers must be re-readable on every invocation without
//     re-registering, otherwise we'd churn `setActionHandler` every
//     React render. The ref + indirection pattern is awkward to inline
//     but trivial to encapsulate.
//   - Cleanup: when the reader unmounts (or `enabled` flips false), we
//     have to null out metadata, handlers, and playbackState so a stale
//     "Sentence 12 of 800" doesn't linger on the lock screen.
//
// Spec references:
//   - https://www.w3.org/TR/mediasession/
//   - MediaSessionActionDetails carries `seekOffset`, `seekTime`,
//     `fastSeek` for the seek family.

import { useEffect, useRef } from "react";

export type MediaSessionMetadataInput = {
  title: string;
  artist: string;
  album: string;
  artwork?: MediaImage[];
};

export type MediaSessionHandlers = {
  onPlay: () => void;
  onPause: () => void;
  onNextTrack: () => void;
  onPreviousTrack: () => void;
  onSeekBackward?: (offsetSeconds: number) => void;
  onSeekForward?: (offsetSeconds: number) => void;
  onSeekTo?: (positionSeconds: number, fastSeek?: boolean) => void;
  onStop?: () => void;
};

export type MediaSessionPlaybackState = "none" | "paused" | "playing";

export type MediaSessionPositionState = {
  duration: number;
  position: number;
  playbackRate: number;
} | null;

type Args = {
  enabled: boolean;
  metadata: MediaSessionMetadataInput;
  handlers: MediaSessionHandlers;
  playbackState: MediaSessionPlaybackState;
  positionState: MediaSessionPositionState;
};

// All actions we ever register. Listed once so the cleanup loop and the
// register loop can't drift apart.
const ALL_ACTIONS: MediaSessionAction[] = [
  "play",
  "pause",
  "previoustrack",
  "nexttrack",
  "stop",
  "seekbackward",
  "seekforward",
  "seekto",
];

function isSupported(): boolean {
  return typeof navigator !== "undefined" && "mediaSession" in navigator;
}

export function useMediaSession(args: Args): void {
  const {
    enabled,
    metadata,
    handlers,
    playbackState,
    positionState,
  } = args;

  // Keep latest handlers in a ref so action callbacks read the current
  // closure without forcing setActionHandler to re-run on every render.
  const handlersRef = useRef<MediaSessionHandlers>(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  // ---- Metadata ----
  // Depend on primitive fields rather than `metadata` identity so a new
  // object literal per render doesn't churn MediaMetadata.
  const artwork = metadata.artwork;
  const artworkKey = artwork ? JSON.stringify(artwork) : "";
  useEffect(() => {
    if (!isSupported()) return;
    if (!enabled) {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
      artwork: artwork ?? [],
    });
    // artwork is referenced via artworkKey for change detection; the
    // actual array is read above. Listing both keeps the lint rule
    // honest without re-running on identity churn.
  }, [enabled, metadata.title, metadata.artist, metadata.album, artwork, artworkKey]);

  // ---- Action handlers ----
  // Re-run when `enabled` flips, or when the *presence* of an optional
  // handler changes — flipping presence has to null out the matching
  // OS button. We don't depend on handler identity because the
  // registered callbacks read `handlersRef.current` on every fire.
  const hasStop = !!handlers.onStop;
  const hasSeekBack = !!handlers.onSeekBackward;
  const hasSeekFwd = !!handlers.onSeekForward;
  const hasSeekTo = !!handlers.onSeekTo;
  useEffect(() => {
    if (!isSupported()) return;
    if (!enabled) return;
    const ms = navigator.mediaSession;

    // play / pause / next / previous are always registered when enabled.
    ms.setActionHandler("play", () => handlersRef.current.onPlay());
    ms.setActionHandler("pause", () => handlersRef.current.onPause());
    ms.setActionHandler("previoustrack", () =>
      handlersRef.current.onPreviousTrack(),
    );
    ms.setActionHandler("nexttrack", () => handlersRef.current.onNextTrack());

    // Optional handlers: register only when the caller supplies one. If
    // we always register, the surface shows a button the caller can't
    // service. Passing `null` explicitly hides the control on
    // platforms that respect it.
    if (hasStop) {
      ms.setActionHandler("stop", () => handlersRef.current.onStop?.());
    } else {
      ms.setActionHandler("stop", null);
    }

    if (hasSeekBack) {
      ms.setActionHandler("seekbackward", (details) => {
        const offset = details.seekOffset ?? 10;
        handlersRef.current.onSeekBackward?.(offset);
      });
    } else {
      ms.setActionHandler("seekbackward", null);
    }

    if (hasSeekFwd) {
      ms.setActionHandler("seekforward", (details) => {
        const offset = details.seekOffset ?? 10;
        handlersRef.current.onSeekForward?.(offset);
      });
    } else {
      ms.setActionHandler("seekforward", null);
    }

    if (hasSeekTo) {
      ms.setActionHandler("seekto", (details) => {
        const time = details.seekTime;
        if (typeof time !== "number" || !Number.isFinite(time)) return;
        handlersRef.current.onSeekTo?.(time, details.fastSeek ?? false);
      });
    } else {
      ms.setActionHandler("seekto", null);
    }

    return () => {
      // Setting handlers to null on cleanup is the documented way to
      // tell the OS the surface is no longer driveable.
      for (const action of ALL_ACTIONS) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          // Some older browsers throw on unknown actions; ignore.
        }
      }
    };
  }, [enabled, hasStop, hasSeekBack, hasSeekFwd, hasSeekTo]);

  // ---- Playback state ----
  useEffect(() => {
    if (!isSupported()) return;
    navigator.mediaSession.playbackState = enabled ? playbackState : "none";
  }, [enabled, playbackState]);

  // ---- Position state ----
  useEffect(() => {
    if (!isSupported()) return;
    const ms = navigator.mediaSession;
    if (!("setPositionState" in ms)) return;
    if (!enabled || positionState === null) {
      try {
        ms.setPositionState({});
      } catch {
        // Safari historically throws on empty input; ignore — the only
        // observable effect of failure is a slightly stale scrubber.
      }
      return;
    }
    const { duration, position, playbackRate } = positionState;
    if (!Number.isFinite(duration) || duration <= 0) return;
    if (!Number.isFinite(position) || position < 0) return;
    try {
      ms.setPositionState({
        duration,
        position: Math.min(position, duration),
        playbackRate,
      });
    } catch {
      // Bad combinations (e.g. position > duration after a race) will
      // throw on Safari. Skip rather than crashing the reader.
    }
  }, [enabled, positionState]);

  // ---- Unmount cleanup ----
  // When the reader unmounts (route change, tab close), explicitly clear
  // metadata and playback state. Without this the lock-screen widget
  // keeps showing "Some Book" with the action handlers nulled — the
  // user sees buttons that visibly do nothing. Safari is the worst
  // offender here because it caches the session aggressively.
  useEffect(() => {
    return () => {
      if (!isSupported()) return;
      try {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
        if ("setPositionState" in navigator.mediaSession) {
          navigator.mediaSession.setPositionState({});
        }
      } catch {
        // Best-effort; the hook is unmounting either way.
      }
    };
  }, []);
}
