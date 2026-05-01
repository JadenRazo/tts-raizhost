// Sleep-timer math.
//
// The actual timer state lives in the reader (it has the audio element
// and the playing intent). This module just packages the pure
// computations: fade volume, format remaining time, validate duration.
//
// Why fade for the last 30 seconds: an instant cut-off mid-sentence is
// jarring at low ambient volume (drift-off-to-sleep listeners notice
// silence more than gradual fade). 30s is the audiobook-app norm.

export const FADE_DURATION_MS = 30_000;

export type SleepTimerMode =
  | { kind: "off" }
  | { kind: "duration"; expiresAt: number }
  | { kind: "end-of-page"; setOnPage: number };

/** Volume coefficient (0..1) for the audio element given the remaining
 *  time on the timer. Constant 1 above the fade window; linear ramp
 *  inside it; 0 once expired. */
export function fadeVolumeForRemaining(
  remainingMs: number,
  fadeMs: number = FADE_DURATION_MS,
): number {
  if (!Number.isFinite(remainingMs) || remainingMs >= fadeMs) return 1;
  if (remainingMs <= 0) return 0;
  return Math.max(0, Math.min(1, remainingMs / fadeMs));
}

/** "MM:SS" or "HH:MM:SS" (only for >= 1h). Used in the timer button
 *  badge. Returns "0:00" for non-finite input. */
export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const totalSeconds = Math.ceil(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export const DURATION_OPTIONS_MINUTES = [15, 30, 45, 60] as const;
