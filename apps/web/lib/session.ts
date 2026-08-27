import { redirect } from 'next/navigation';

import { auth } from '../auth';

export interface CurrentUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

/**
 * The only way server code should learn who is asking.
 *
 * Never accept a user id from the client: every server action and server component re-derives
 * it from the session cookie here, and scopes its queries by the result.
 */
export async function requireUser(): Promise<CurrentUser> {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  return {
    id: session.user.id,
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    image: session.user.image ?? null,
  };
}

/** Same, but for code that wants to render something for signed-out visitors too. */
export async function currentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    image: session.user.image ?? null,
  };
}
