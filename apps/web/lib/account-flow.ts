import "server-only";
import type { ServerAnalytics } from "./analytics-server";
import { SESSION_COOKIE } from "./auth-flow";
import type { ConnectionStore } from "./connections";
import { decryptRefreshToken } from "./crypto";
import type { Authenticate } from "./gmail-flow";
import type { GoogleProvider } from "./google";
import { cookieHeader, redirectResponse, sameOrigin } from "./http";
import type { SupabaseAdmin } from "./supabase-auth";

export function createAccountHandler(config: {
  origin: string;
  key: string;
  authenticate: Authenticate;
  store: ConnectionStore;
  google: GoogleProvider;
  admin: SupabaseAdmin;
  analytics?: ServerAnalytics;
}) {
  const forbidden = () =>
    new Response("Request origin is not allowed", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  return async function deleteAccount(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST", "Cache-Control": "no-store" },
      });
    if (!sameOrigin(request, config.origin)) return forbidden();
    let confirmation: FormData;
    try {
      confirmation = await request.formData();
    } catch {
      return new Response("Confirmation is required", { status: 400 });
    }
    if (confirmation.get("confirmation") !== "delete")
      return new Response("Type delete to confirm account deletion", {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      });

    try {
      const identity = await config.authenticate(request);
      if (!identity)
        return redirectResponse(config.origin, "/dashboard?auth=required");
      // Every connected account gets its token revoked. One failure does not
      // stop the others, and none of them keeps the account alive: the user
      // asked for deletion, so a revocation outage must not preserve their data.
      let encrypted: string[] = [];
      try {
        encrypted = await config.store.readEncryptedTokens(identity.user.id);
      } catch {
        console.error("[ERROR] account_google_revocation_failed");
      }
      for (const token of encrypted) {
        try {
          await config.google.revoke(
            decryptRefreshToken(token, config.key, identity.user.id),
          );
        } catch {
          console.error("[ERROR] account_google_revocation_failed");
        }
      }
      await config.admin.deleteUser(identity.user.id);
      // Deleting the user removes their analytics rows with them, so this
      // event is kept against the browser only.
      await config.analytics?.track(request, "account_deleted", {
        properties: { account_count: encrypted.length },
      });
      const response = redirectResponse(config.origin, "/?account=deleted");
      response.headers.append(
        "Set-Cookie",
        cookieHeader(SESSION_COOKIE, "", config.origin, 0),
      );
      return response;
    } catch {
      console.error("[ERROR] account_delete_failed");
      return redirectResponse(config.origin, "/settings?delete=failed");
    }
  };
}
