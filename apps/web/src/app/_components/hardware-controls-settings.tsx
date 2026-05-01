"use client";

// Settings panel for what CarPlay / Bluetooth / lock-screen controls
// do. Rendered inline in the reader (below the playback controls) when
// the user clicks the gear button. Each dropdown is constrained to the
// subset of actions that make sense on that surface — e.g. seek-forward
// can't be mapped to "restart book" because the OS treats seekforward
// as a continuous seek action and the UI for that is a long-press.

import {
  ACTION_LABELS,
  DEFAULT_HARDWARE_CONTROLS,
  type HardwareControlSettings,
  type MediaAction,
  NEXT_TRACK_ACTIONS,
  type NextTrackAction,
  PREV_TRACK_ACTIONS,
  type PrevTrackAction,
  SEEK_BACKWARD_ACTIONS,
  type SeekBackwardAction,
  SEEK_FORWARD_ACTIONS,
  type SeekForwardAction,
} from "@/lib/media-actions";

const SEEK_STEP_OPTIONS = [5, 10, 15, 30, 45, 60] as const;
const SMART_REWIND_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 3, label: "3s" },
  { value: 5, label: "5s" },
  { value: 10, label: "10s" },
  { value: 15, label: "15s" },
  { value: 30, label: "30s" },
] as const;

type Props = {
  settings: HardwareControlSettings;
  onChange: (patch: Partial<HardwareControlSettings>) => void;
  smartRewindSeconds: number;
  onSmartRewindChange: (seconds: number) => void;
  onClose: () => void;
};

export function HardwareControlsSettings({
  settings,
  onChange,
  smartRewindSeconds,
  onSmartRewindChange,
  onClose,
}: Props) {
  return (
    <section
      aria-label="CarPlay & Bluetooth controls"
      className="rounded-lg border border-border bg-surface p-4"
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-fg">
            CarPlay &amp; Bluetooth controls
          </h2>
          <p className="mt-1 max-w-xl text-xs text-muted">
            Different cars and headsets send different signals when you press
            the wheel skip buttons. Pick what each one should do — defaults
            match the way audiobook apps usually behave.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close hardware-controls settings"
          className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg"
        >
          Close
        </button>
      </header>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <ActionField<SeekForwardAction>
          label="Skip forward (most cars)"
          help="Wheel skip-forward, lock-screen ›› button. Audiobook mode usually sends this."
          options={SEEK_FORWARD_ACTIONS}
          value={settings.seekForwardAction}
          onChange={(v) => onChange({ seekForwardAction: v })}
        />
        <ActionField<SeekBackwardAction>
          label="Skip backward (most cars)"
          help="Wheel skip-back, lock-screen ‹‹ button."
          options={SEEK_BACKWARD_ACTIONS}
          value={settings.seekBackwardAction}
          onChange={(v) => onChange({ seekBackwardAction: v })}
        />
        <ActionField<NextTrackAction>
          label="Next track"
          help="Some headsets and CarPlay UI buttons send this instead of skip-forward."
          options={NEXT_TRACK_ACTIONS}
          value={settings.nextTrackAction}
          onChange={(v) => onChange({ nextTrackAction: v })}
        />
        <ActionField<PrevTrackAction>
          label="Previous track"
          help="If set to “previous sentence”, mid-sentence presses restart the current sentence."
          options={PREV_TRACK_ACTIONS}
          value={settings.prevTrackAction}
          onChange={(v) => onChange({ prevTrackAction: v })}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <label className="flex items-center gap-2 text-xs text-muted">
          <span>Skip step</span>
          <select
            value={settings.seekStepSeconds}
            onChange={(e) =>
              onChange({ seekStepSeconds: Number(e.target.value) })
            }
            className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg tabular-nums"
          >
            {SEEK_STEP_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}s
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-subtle">
          Used when skip is set to “Skip forward (seconds)” / “Skip back
          (seconds)”. Cars that pass their own step (e.g. 15s from CarPlay)
          win over this value.
        </p>
        <button
          type="button"
          onClick={() => onChange(DEFAULT_HARDWARE_CONTROLS)}
          className="ml-auto rounded-md border border-border px-3 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg"
        >
          Reset to defaults
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <label className="flex items-center gap-2 text-xs text-muted">
          <span className="text-fg">Smart rewind on resume</span>
          <select
            value={smartRewindSeconds}
            onChange={(e) => onSmartRewindChange(Number(e.target.value))}
            className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg tabular-nums"
          >
            {SMART_REWIND_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <p className="max-w-md text-xs text-subtle">
          When you press Play after a long pause (over 30 seconds), the
          reader rewinds this far so you re-establish context. Audible /
          AudioBooth call this “Smart Rewind”.
        </p>
      </div>
    </section>
  );
}

type ActionFieldProps<A extends MediaAction> = {
  label: string;
  help: string;
  options: readonly A[];
  value: A;
  onChange: (next: A) => void;
};

function ActionField<A extends MediaAction>({
  label,
  help,
  options,
  value,
  onChange,
}: ActionFieldProps<A>) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      <span className="text-fg">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as A)}
        className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {ACTION_LABELS[opt].label}
          </option>
        ))}
      </select>
      <span className="text-[0.7rem] text-subtle">{help}</span>
    </label>
  );
}
