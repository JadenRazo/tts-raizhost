// Next.js instrumentation hook — runs once per server cold start,
// before any request is served. We use it to start the backend
// selector's probe loop so the breaker has fresh state by the time
// real traffic arrives.
//
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
//
// The import of `./instrumentation.node` lives behind a NEXT_RUNTIME
// check so webpack tree-shakes the entire Node-only module out of the
// Edge runtime bundle. Without this split, webpack traces prom-client
// (a transitive dep of tts-backend-selector) into the Edge build and
// fails on `cluster`, `v8`, `fs`, and other Node built-ins.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}
