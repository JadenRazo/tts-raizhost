// Prometheus exposition endpoint.
//
// Gated to loopback + RFC1918 source addresses. Caddy on the host does
// not proxy /api/metrics — that's the public-side gate. In-cluster
// Prometheus scrapes via the tts-web Service (kube-proxy routes to the
// node IP since the pod is hostNetwork), and pods talk over RFC1918
// addresses, so this passes. Any external request that somehow reaches
// the bind would carry an X-Forwarded-For header set by Caddy, or a
// non-private remote IP — both are denied.

import { headers } from "next/headers";

import { registry } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const h = await headers();

  // If Caddy proxied this request, X-Forwarded-For is set. /api/metrics
  // is never proxied by Caddy → presence of XFF means the request came
  // from the public side. Deny.
  if (h.get("x-forwarded-for")) {
    return new Response("forbidden", { status: 403 });
  }

  // Best-effort source check via headers Next.js exposes. If not
  // resolvable, fall through to the XFF-absent gate above.
  const remote = h.get("x-real-ip") ?? "";
  if (remote && !isLoopbackOrRfc1918(remote)) {
    return new Response("forbidden", { status: 403 });
  }

  const body = await registry.metrics();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": registry.contentType,
      "cache-control": "no-store",
    },
  });
}

function isLoopbackOrRfc1918(addr: string): boolean {
  if (addr === "127.0.0.1" || addr === "::1") return true;
  // IPv4-mapped IPv6 form (e.g. ::ffff:10.0.0.1)
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return false;
  const parts = v4.split(".").map((n) => parseInt(n, 10));
  if (parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  return false;
}
