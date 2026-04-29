// Root route. Branches by session:
//   - Unauthenticated visitors get the marketing landing with sign-in/sign-up CTAs.
//   - Authenticated users get their library.
//
// Both views read from the shared design tokens defined in globals.css.

import { getSession } from "@/lib/auth/session";
import { LandingView } from "./_components/landing-view";
import { LibraryView } from "./_components/library-view";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();
  if (!session) {
    return <LandingView />;
  }
  const user = session.user as { id: string; email: string };
  return <LibraryView userId={user.id} email={user.email} />;
}
