// Single source of truth for the Kokoro voice IDs we accept at the
// edge. Mirrors services/kokoro/synth.py:VOICE_CATALOG. The prerender
// and synth routes both validate against this set so a forged voice
// gets rejected before it reaches the synth pod.
//
// Adding a voice: append the ID here, deploy, then enable on the
// kokoro side in the same release.

export type VoiceAccent = "american" | "british";
export type VoiceGender = "female" | "male";

export type VoiceMeta = {
  id: string;
  name: string;
  accent: VoiceAccent;
  gender: VoiceGender;
  // Overall grade from huggingface.co/hexgrad/Kokoro-82M VOICES.md.
  // Useful for sorting/badging in pickers; omit for forward-compat
  // (treat unknown as "ungraded").
  grade?: string;
};

// Curated list — only the voices we actively advertise. The Kokoro
// model ships with 28 English voices but most are graded D or below;
// we keep the catalog short so the picker stays opinionated.
export const VOICE_CATALOG: readonly VoiceMeta[] = [
  { id: "af_heart",   name: "Heart",   accent: "american", gender: "female", grade: "A" },
  { id: "af_bella",   name: "Bella",   accent: "american", gender: "female", grade: "A-" },
  { id: "bf_emma",    name: "Emma",    accent: "british",  gender: "female", grade: "B-" },
  { id: "am_michael", name: "Michael", accent: "american", gender: "male",   grade: "C+" },
  { id: "am_puck",    name: "Puck",    accent: "american", gender: "male",   grade: "C+" },
];

export const ALLOWED_VOICES: ReadonlySet<string> = new Set<string>(
  VOICE_CATALOG.map((v) => v.id),
);

export const DEFAULT_VOICE = "af_heart";
