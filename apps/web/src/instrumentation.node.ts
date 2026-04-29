// Node-only side of the Next.js instrumentation hook. Imported
// dynamically by ./instrumentation.ts under a NEXT_RUNTIME==='nodejs'
// guard so webpack never bundles its transitive deps (prom-client,
// which uses node:cluster/v8/fs) into the Edge runtime.

import { startProbeLoop } from "@/lib/tts-backend-selector";

console.info("[tts] instrumentation.node loaded, starting probe loop");
startProbeLoop();
