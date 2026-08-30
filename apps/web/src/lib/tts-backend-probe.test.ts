import assert from "node:assert/strict";
import test from "node:test";

import { probePrimaryBackend } from "./tts-backend-probe.ts";

const noTimeout = { healthMs: 60_000, synthMs: 60_000 };

test("accepts a ready backend that produces a first audio byte", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };

  assert.deepEqual(
    await probePrimaryBackend("http://primary", fetcher, noTimeout),
    { ok: true },
  );
  assert.deepEqual(calls, [
    "http://primary/healthz",
    "http://primary/tts",
  ]);
});

test("rejects a backend whose readiness endpoint fails", async () => {
  const fetcher: typeof fetch = async () => new Response(null, { status: 503 });

  assert.deepEqual(
    await probePrimaryBackend("http://primary", fetcher, noTimeout),
    { ok: false, reason: "healthz 503" },
  );
});

test("rejects a backend that returns no synthesis bytes", async () => {
  let call = 0;
  const fetcher: typeof fetch = async () => {
    call += 1;
    return call === 1
      ? new Response("ok", { status: 200 })
      : new Response(new Uint8Array(), { status: 200 });
  };

  assert.deepEqual(
    await probePrimaryBackend("http://primary", fetcher, noTimeout),
    { ok: false, reason: "synth empty body" },
  );
});
