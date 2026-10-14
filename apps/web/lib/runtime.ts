import "server-only";
import { createAuthHandlers, readSession } from "./auth-flow";
import { createConnectionStore, type PublicConnection } from "./connections";
import { type Authenticate, createGmailHandlers } from "./gmail-flow";
import { createGoogleProvider } from "./google";
import { createSupabaseAuth, type SignedInUser } from "./supabase-auth";

type DashboardState =
  | { kind: "signed_out" | "refresh" | "unavailable" }
  | {
      kind: "signed_in";
      user: SignedInUser;
      connection: PublicConnection | null;
    };
interface RuntimeConfig {
  origin: string;
  key: string;
  supabaseUrl: string;
  anonKey: string;
  serviceKey: string;
  googleClientId: string;
  googleClientSecret: string;
  testOAuthOrigin?: string;
  fetcher?: typeof fetch;
}

export function createRuntime(config: RuntimeConfig) {
  const auth = createSupabaseAuth({
    url: config.supabaseUrl,
    anonKey: config.anonKey,
    fetcher: config.fetcher,
  });
  const store = createConnectionStore({
    url: config.supabaseUrl,
    anonKey: config.anonKey,
    serviceKey: config.serviceKey,
    fetcher: config.fetcher,
  });
  const google = createGoogleProvider({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    testOAuthOrigin: config.testOAuthOrigin,
    fetcher: config.fetcher,
  });
  const authenticate: Authenticate = async (request) => {
    const session = readSession(request, config.key);
    if (!session) return null;
    const user = await auth.getUser(session.accessToken);
    return user ? { user, accessToken: session.accessToken } : null;
  };
  return {
    ...createGmailHandlers({
      origin: config.origin,
      key: config.key,
      authenticate,
      store,
      google,
    }),
    auth: createAuthHandlers({ origin: config.origin, key: config.key, auth }),
    async dashboard(request: Request): Promise<DashboardState> {
      try {
        const session = readSession(request, config.key);
        if (!session) return { kind: "signed_out" };
        if (session.expiresAt <= Date.now()) return { kind: "refresh" };
        const identity = await authenticate(request);
        if (!identity) return { kind: "signed_out" };
        const connection = await store.readPublic(
          identity.user.id,
          identity.accessToken,
        );
        return { kind: "signed_in", user: identity.user, connection };
      } catch {
        console.error("[ERROR] runtime_dashboard_failed");
        return { kind: "unavailable" };
      }
    },
  };
}

export function configuredRuntime(): ReturnType<typeof createRuntime> | null {
  const env = process.env;
  if (
    !env.APP_URL ||
    !env.NEXT_PUBLIC_SUPABASE_URL ||
    !env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    !env.SUPABASE_SERVICE_ROLE_KEY ||
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.TOKEN_ENCRYPTION_KEY
  )
    return null;
  try {
    const app = new URL(env.APP_URL);
    if (
      app.protocol !== "https:" &&
      !(
        app.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(app.hostname)
      )
    )
      return null;
    return createRuntime({
      origin: app.origin,
      key: env.TOKEN_ENCRYPTION_KEY,
      supabaseUrl: new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin,
      anonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
      testOAuthOrigin: env.RECURMAIL_TEST_OAUTH_ORIGIN,
    });
  } catch {
    console.error("[ERROR] runtime_configuration_failed");
    return null;
  }
}

export async function runRoute(
  route:
    | "signin"
    | "authCallback"
    | "refresh"
    | "connect"
    | "callback"
    | "disconnect",
  request: Request,
): Promise<Response> {
  const runtime = configuredRuntime();
  if (!runtime)
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/dashboard?auth=unavailable",
        "Cache-Control": "no-store",
      },
    });
  if (route === "signin") return runtime.auth.signin();
  if (route === "authCallback") return runtime.auth.callback(request);
  if (route === "refresh") return runtime.auth.refresh(request);
  return runtime[route](request);
}
