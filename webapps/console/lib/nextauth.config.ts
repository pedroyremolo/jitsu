import GithubProvider from "next-auth/providers/github";
import KeycloakProvider from "next-auth/providers/keycloak";
import CredentialsProvider from "next-auth/providers/credentials";
import { NextAuthOptions, User } from "next-auth";
import { db } from "./server/db";
import { checkHash, createHash, hash, requireDefined } from "juava";
import { ApiError } from "./shared/errors";
import { getServerLog } from "./server/log";
import { withProductAnalytics } from "./server/telemetry";
import { NextApiRequest } from "next";
import { isTruish } from "./shared/chores";
import { onUserCreated } from "./server/ee";

const crypto = require("crypto");

const log = getServerLog("auth");

export const githubLoginEnabled = !!process.env.GITHUB_CLIENT_ID;
export const keycloakLoginEnabled = !!(process.env.KEYCLOAK_CLIENT_ID && process.env.KEYCLOAK_CLIENT_SECRET && process.env.KEYCLOAK_ISSUER);
export const credentialsLoginEnabled =
  isTruish(process.env.ENABLE_CREDENTIALS_LOGIN) || !!(process.env.SEED_USER_EMAIL && process.env.SEED_USER_PASSWORD);

const githubProvider = githubLoginEnabled
  ? GithubProvider({
    clientId: process.env.GITHUB_CLIENT_ID as string,
    clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
  })
  : undefined;

const keycloakProvider = keycloakLoginEnabled? KeycloakProvider({
  clientId: process.env.KEYCLOAK_CLIENT_ID as string,
  clientSecret: process.env.KEYCLOAK_CLIENT_SECRET as string,
  issuer: process.env.KEYCLOAK_ISSUER as string,
}): undefined;

function toId(email: string) {
  return hash("sha256", email.toLowerCase().trim());
}

const credentialsProvider =
  credentialsLoginEnabled &&
  CredentialsProvider({
    authorize: async function (credentials) {
      if (!credentials) {
        log.atWarn().log(`Failed attempt to login with empty credentials`);
        return null;
      }
      const username = credentials.username;
      if (!username) {
        throw new ApiError("Username is not defined");
      }
      console.log(JSON.stringify(credentials, null, 2));
      const user = await db.prisma().userProfile.findFirst({ where: { email: username }, include: { password: true } });
      if (!user) {
        log.atDebug().log(`Attempt to login with unknown user: ${username}`);
        const profileCount = await db.prisma().userProfile.count();
        if (profileCount === 0 && process.env.SEED_USER_EMAIL && process.env.SEED_USER_PASSWORD) {
          log.atDebug().log(`There're no user profiles in DB, checking ${username} against seed user config`);
          if (process.env.SEED_USER_EMAIL === username && process.env.SEED_USER_PASSWORD === credentials.password) {
            const userId = toId(process.env.SEED_USER_EMAIL);
            log.atDebug().log(`Adding a seed admin user with id ${userId} and email ${username}`);
            await db.prisma().userProfile.create({
              data: {
                id: userId,
                email: username,
                name: username,
                externalId: userId,
                loginProvider: "credentials",
                admin: true,
                password: {
                  create: {
                    hash: createHash(credentials.password),
                    changeAtNextLogin: true,
                  },
                },
              },
            });
            return {
              id: userId,
              externalId: userId,
              email: process.env.SEED_USER_EMAIL,
              name: process.env.SEED_USER_EMAIL,
            };
          } else {
            log.atWarn().log(`Attempt to login with unknown user: ${username} and invalid password`);
          }
        }
      } else if (user.password && checkHash(user.password.hash, credentials.password)) {
        log.atDebug().log(`User ${username} logged in successfully with password`);
        return {
          id: user.id,
          externalId: user.externalId,
          email: user.email,
          name: user.name,
        };
      }
      log.atDebug().log(`Unsuccessful login attempt: user ${username} exists, but password is invalid`);
      return null;
    },
    credentials: {
      username: { label: "Email", type: "text" },
      password: { label: "Password", type: "password" },
    },
  });

export async function getOrCreateUser(opts: {
  externalId: string;
  loginProvider: string;
  name?: string;
  email: string;
  // we only need this for product analytics, so it's optional
  req?: NextApiRequest;
}): Promise<User> {
  const { externalId, loginProvider, email, name = email } = opts;
  let user = await db.prisma().userProfile.findFirst({ where: { externalId, loginProvider } });
  if (!user) {
    if (process.env.DISABLE_SIGNUP === "true" || process.env.DISABLE_SIGNUP === "1") {
      throw new ApiError("Sign up is disabled", { code: "signup-disabled" });
    }
    //first user is admin
    const admin = !(await db.prisma().userProfile.count());
    user = await db.prisma().userProfile.create({
      data: {
        //we need this to be consistent with id generated by .authorize() call
        id: loginProvider === "credentials" ? externalId : undefined,
        email,
        name,
        externalId: externalId,
        loginProvider: loginProvider,
        admin,
      },
    });
    await withProductAnalytics(p => p.track("user_created"), {
      user: { email, name, internalId: user.id, externalId, loginProvider },
      req: opts.req,
    });
    await onUserCreated({ email, name });
  } else if (user.name !== name || user.email !== email) {
    await db.prisma().userProfile.update({ where: { id: user.id }, data: { name, email } });
  }
  return user;
}

function generateSecret(base: (string | undefined)[]) {
  const hash = crypto.createHash("sha256");
  hash.update(base.map(s => s || "empty").join(":"));
  const secretKey = hash.digest("hex");
  log.atInfo().log("Using autogenerated JWT key", secretKey);
  return secretKey;
}

export const nextAuthConfig: NextAuthOptions = {
  // Configure one or more authentication providers
  providers: [githubProvider, keycloakProvider, credentialsProvider].filter(provider => !!provider) as any,
  pages: {
    error: "/error/auth", // Error code passed in query string as ?error=
    signIn: "/signin", // Displays signin buttons
  },

  secret:
    process.env.JWT_SECRET ||
    generateSecret([
      "v2",
      process.env.GITHUB_CLIENT_ID,
      process.env.GOOGLE_CLIENT_ID,
      process.env.DATABASE_URL,
      process.env.REDIS_URL,
    ]),
  callbacks: {
    jwt: async props => {
      const loginProvider = (props.account?.provider || props.token.loginProvider || "credentials") as string;
      const externalId = requireDefined(props.token.sub, `JWT token .sub is not defined`);
      const email = requireDefined(props.token.email, `JWT token .email is not defined`);
      const user = await getOrCreateUser({
        externalId,
        loginProvider,
        email,
        name: props.token.name || email,
      });
      return {
        internalId: user.id,
        externalId: externalId,
        externalUsername: props.profile?.["login"],
        loginProvider: loginProvider,
        ...props.token,
      };
    },
    async session({ session, token }) {
      return {
        ...session,
        internalId: token.internalId,
        loginProvider: token.loginProvider,
        externalId: token.externalId,
        externalUsername: token.externalUsername,
      };
    },
  },
};
