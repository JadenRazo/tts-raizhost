// Session helpers for server components and route handlers.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./index";

export async function getSession() {
  const auth = getAuth();
  return auth.api.getSession({ headers: await headers() });
}

export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  return session;
}

export async function requireAdmin() {
  const session = await requireAuth();
  if (!(session.user as { isAdmin?: boolean }).isAdmin) {
    redirect("/");
  }
  return session;
}
