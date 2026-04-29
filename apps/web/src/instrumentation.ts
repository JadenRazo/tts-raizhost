// Next.js instrumentation hook — runs once per server cold start, before
// any request is served. We use it to start the backend selector's
// probe loop so the breaker has fresh state by the time real traffic
// arrives.
//
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
//
// Only runs on the Node.js server (NEXT_RUNTIME === 'nodejs'). The Edge
// runtime has no setInterval / fetch-with-AbortSignal.timeout combo
// that we use, but the TTS route is also Node-only so there's no edge
// codepath to worry about.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startProbeLoop } = await import("@/lib/tts-backend-selector");
  startProbeLoop();
}
