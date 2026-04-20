import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// ⚠ TIJDELIJK: passwordless — elke geldige user-email is voldoende om in te loggen.
// Gebruikt tijdens development/demo. Zet bcrypt-compare terug zodra auth weer echt
// moet werken (zie `git log` voor de vorige versie).
export const authConfig: NextAuthConfig = {
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email) return null;
        const email = credentials.email as string;

        const user = await db.query.users.findFirst({
          where: eq(users.email, email),
          with: { organization: true },
        });
        if (!user || !user.active) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          orgId: user.orgId,
          orgRole: user.organization.role,
          orgName: user.organization.name,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.orgId = (user as any).orgId;
        token.orgRole = (user as any).orgRole;
        token.orgName = (user as any).orgName;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub!;
        (session.user as any).orgId = token.orgId;
        (session.user as any).orgRole = token.orgRole;
        (session.user as any).orgName = token.orgName;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
};
