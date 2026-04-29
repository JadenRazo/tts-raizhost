// Global route guard. Public paths (login, enroll, recover, the auth API)
// pass through. Everything else redirects to /login if no session cookie
// is present. Note: we only check cookie presence, not validity — the
// underlying server-component requireAuth() does the real DB lookup. This
// keeps the middleware fast (no DB call per request).

import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// `/` is public so the LandingView renders for signed-out visitors; the
// page itself branches on session and shows the library only when present.
const PUBLIC_PATHS = ["/", "/login", "/signup", "/recover"];
const PUBLIC_PREFIXES = ["/enroll/", "/api/auth/", "/_next/", "/favicon"];

function buildAbsoluteUrl(req: NextRequest, path: string): string {
  // Trust X-Forwarded-* headers from the front-door (Caddy) over the
  // upstream-bind url that NextRequest defaults to. This way the redirect
  // points at tts.raizhost.com, not the pod's loopback bind.
  const proto =
    req.headers.get("x-forwarded-proto") ??
    req.nextUrl.protocol.replace(":", "");
  const host =
    req.headers.get("x-forwarded-host") ??
    req.headers.get("host") ??
    req.nextUrl.host;
  return `${proto}://${host}${path}`;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    PUBLIC_PATHS.includes(pathname) ||
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
  ) {
    return NextResponse.next();
  }

  // API routes own their own auth gating (each handler calls getSession()
  // and returns 401 JSON). Don't redirect them to /login HTML — browsers
  // would follow the redirect and try to interpret HTML as JSON or audio.
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const cookie = getSessionCookie(req, { cookiePrefix: "tts" });
  if (!cookie) {
    const target = buildAbsoluteUrl(
      req,
      `/login?next=${encodeURIComponent(pathname)}`,
    );
    return NextResponse.redirect(target);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.).*)"],
};
