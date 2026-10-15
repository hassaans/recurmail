"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { StatusPage, statusStyles } from "../components/StatusPage";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <StatusPage
      eyebrow="Something went wrong"
      title="This page didn't load"
      actions={
        <>
          <button
            type="button"
            className={statusStyles.primary}
            onClick={() => reset()}
          >
            Try again
          </button>
          <a className={statusStyles.secondary} href="/dashboard">
            Open your dashboard
          </a>
        </>
      }
    >
      We've been notified. Your schedules keep sending on time while we look
      into it.
    </StatusPage>
  );
}
