import "server-only";
import { createAccountHandler } from "./account-flow";
import { createAuthHandlers, readSession } from "./auth-flow";
import { createConnectionStore, type PublicConnection } from "./connections";
import { type Authenticate, createGmailHandlers } from "./gmail-flow";
import { createGoogleProvider } from "./google";
import { createGoogleSignIn } from "./google-signin";
import { createScheduleStore } from "./schedule-store";
import { createScheduleHandlers, scheduleJson } from "./schedules";
import {
  createSupabaseAdmin,
  createSupabaseAuth,
  type SignedInUser,
} from "./supabase-auth";
import { createTestSendHandler, createTestSendStore } from "./test-send";

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
  publishableKey: string;
  secretKey: string;
  googleClientId: string;
  googleClientSecret: string;
  testOAuthOrigin?: string;
  testGmailOrigin?: string;
  fetcher?: typeof fetch;
}

export function createRuntime(config: RuntimeConfig) {
  const auth = createSupabaseAuth({
    url: config.supabaseUrl,
    publishableKey: config.publishableKey,
    fetcher: config.fetcher,
  });
  const store = createConnectionStore({
    url: config.supabaseUrl,
    publishableKey: config.publishableKey,
    secretKey: config.secretKey,
    fetcher: config.fetcher,
  });
  const admin = createSupabaseAdmin({
    url: config.supabaseUrl,
    secretKey: config.secretKey,
    fetcher: config.fetcher,
  });
  const google = createGoogleProvider({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    testOAuthOrigin: config.testOAuthOrigin,
    testGmailOrigin: config.testGmailOrigin,
    fetcher: config.fetcher,
  });
  const googleSignIn = createGoogleSignIn({
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
    account: createAccountHandler({
      origin: config.origin,
      key: config.key,
      authenticate,
      store,
      google,
      admin,
    }),
    ...createGmailHandlers({
      origin: config.origin,
      key: config.key,
      authenticate,
      store,
      google,
    }),
    auth: createAuthHandlers({
      origin: config.origin,
      key: config.key,
      auth,
      google: googleSignIn,
    }),
    schedules: createScheduleHandlers({
      origin: config.origin,
      authenticate,
      store: createScheduleStore({
        url: config.supabaseUrl,
        publishableKey: config.publishableKey,
        fetcher: config.fetcher,
      }),
    }),
    testSend: createTestSendHandler({
      origin: config.origin,
      key: config.key,
      authenticate,
      google,
      store: createTestSendStore({
        url: config.supabaseUrl,
        secretKey: config.secretKey,
        fetcher: config.fetcher,
      }),
    }),
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

type ScheduleHandlers = ReturnType<typeof createScheduleHandlers>;
type ScheduleCollectionOperation = "list" | "create" | "pauseAll";
type ScheduleItemOperation = Exclude<
  keyof ScheduleHandlers,
  ScheduleCollectionOperation
>;

export function runScheduleRoute(
  operation: ScheduleCollectionOperation,
  request: Request,
): Promise<Response>;
export function runScheduleRoute(
  operation: ScheduleItemOperation,
  request: Request,
  id: string,
): Promise<Response>;
export async function runScheduleRoute(
  operation: keyof ScheduleHandlers,
  request: Request,
  id?: string,
): Promise<Response> {
  const runtime = configuredRuntime();
  if (!runtime)
    return scheduleJson(
      {
        error: { code: "unavailable", message: "Schedule API is unavailable" },
      },
      503,
    );
  if (
    operation === "list" ||
    operation === "create" ||
    operation === "pauseAll"
  )
    return runtime.schedules[operation](request);
  if (!id)
    return scheduleJson(
      { error: { code: "invalid_input", message: "Schedule ID is required" } },
      400,
    );
  return runtime.schedules[operation](request, id);
}

export async function runTestSendRoute(request: Request): Promise<Response> {
  const runtime = configuredRuntime();
  if (!runtime)
    return scheduleJson(
      {
        error: { code: "unavailable", message: "Schedule API is unavailable" },
      },
      503,
    );
  return runtime.testSend(request);
}

export function configuredRuntime(): ReturnType<typeof createRuntime> | null {
  const env = process.env;
  if (
    !env.APP_URL ||
    !env.SUPABASE_URL ||
    !env.SUPABASE_PUBLISHABLE_KEY ||
    !env.SUPABASE_SECRET_KEY ||
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
      supabaseUrl: new URL(env.SUPABASE_URL).origin,
      publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
      secretKey: env.SUPABASE_SECRET_KEY,
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
      testOAuthOrigin: env.RECURMAIL_TEST_OAUTH_ORIGIN,
      testGmailOrigin: env.RECURMAIL_TEST_GMAIL_ORIGIN,
    });
  } catch {
    console.error("[ERROR] runtime_configuration_failed");
    return null;
  }
}

export async function runAccountRoute(request: Request): Promise<Response> {
  const runtime = configuredRuntime();
  if (!runtime)
    return new Response("Account deletion is unavailable", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  return runtime.account(request);
}

export async function runRoute(
  route:
    | "signin"
    | "authCallback"
    | "refresh"
    | "signout"
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
  if (route === "signout") return runtime.auth.signout(request);
  return runtime[route](request);
}
