"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

// Shown only when the root layout itself fails, so it cannot rely on the
// app's styles or fonts; keep it self-contained.
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#f3faf6",
          color: "#1b1530",
          font: "17px/1.6 system-ui, sans-serif",
        }}
      >
        <main style={{ maxWidth: 520, padding: 24 }}>
          <h1 style={{ fontSize: 28, margin: "0 0 12px" }}>
            RecurMail didn't load
          </h1>
          <p style={{ margin: "0 0 24px" }}>
            We've been notified. Your schedules keep sending on time.
          </p>
          <a
            href="/"
            style={{
              display: "inline-block",
              padding: "12px 22px",
              borderRadius: 999,
              background: "#6d3bef",
              color: "#fff",
              fontWeight: 700,
              textDecoration: "none",
            }}
          >
            Reload RecurMail
          </a>
        </main>
      </body>
    </html>
  );
}
