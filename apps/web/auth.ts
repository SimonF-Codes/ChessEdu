import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db, schema } from '@chessedu/db';
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';

/**
 * Google is the only credential path — no passwords are stored, ever.
 *
 * Sessions are stored in the database rather than signed into a JWT, so signing a user out
 * everywhere is a delete rather than a wait for expiry. The cost is that sessions cannot be
 * validated in edge middleware; authorisation therefore happens in server components and
 * server actions instead. See docs/architecture.md, section 10.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db(), {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  }),
  providers: [Google],
  session: { strategy: 'database', maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: '/' },
  callbacks: {
    session({ session, user }) {
      // Expose the user id so server code can scope queries by it without a second lookup.
      session.user.id = user.id;
      return session;
    },
  },
});

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}
