import { describe, expect, it } from "vitest";
import { beforeSend } from "../lib/sentry";

describe("Sentry event scrubbing", () => {
  it("sends only scrubbed errors to the captured transport", () => {
    const captured: Record<string, unknown>[] = [];
    const fakeTransport = {
      send: (event: Record<string, unknown>) => captured.push(event),
    };
    const errorEvent = {
      message: "Failed for owner@example.com: Quarterly report",
      exception: {
        values: [
          {
            type: "Error",
            value: "owner@example.com Quarterly report body text",
          },
        ],
      },
      extra: {
        recipient: "owner@example.com",
        subject: "Quarterly report",
        body: "Private body content",
        detail: "Error request for owner@example.com",
        request: {
          data: "Subject: Quarterly report\nBody: Private body content",
        },
        breadcrumbs: [
          {
            message: "Quarterly report",
            data: { body: "Private body content" },
          },
        ],
      },
    };

    fakeTransport.send(beforeSend(errorEvent));

    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain("Quarterly report");
    expect(serialized).not.toContain("Private body content");
    expect(serialized).toContain("[Filtered email]");
    expect(serialized).toContain("[Filtered]");
  });

  it("removes URL-encoded addresses from page URLs and breadcrumbs", () => {
    const event = beforeSend({
      request: {
        url: "https://recurmail.com/dashboard?gmail=connected&email=owner%40gmail.com",
      },
      breadcrumbs: [
        {
          category: "navigation",
          data: {
            from: "/dashboard?gmail=disconnected&email=first.last%2Btag%40example.co.uk",
            to: "/settings?email=owner%2540gmail.com",
          },
        },
      ],
    });

    const serialized = JSON.stringify(event);
    for (const address of ["owner", "first.last", "gmail.com", "example.co.uk"])
      expect(serialized).not.toContain(address);
    expect(event.request.url).toBe(
      "https://recurmail.com/dashboard?gmail=connected&email=[Filtered email]",
    );
  });

  it("keeps a React error's code but drops its arguments", () => {
    const event = beforeSend({
      exception: {
        values: [
          {
            type: "Error",
            value:
              "Minified React error #418; visit https://react.dev/errors/418?args[]=Quarterly%20report&args[]=owner%40example.com for the full message",
          },
        ],
      },
    });

    expect(event.exception.values[0]?.value).toBe("Minified React error #418");
  });

  it("groups React errors by code and page instead of by stack", () => {
    const hydration = (transaction: string) =>
      beforeSend({
        transaction,
        exception: {
          values: [
            { type: "Error", value: "Minified React error #418; visit" },
          ],
        },
      }).fingerprint;

    expect(hydration("/")).toEqual(["react-error", "418", "/"]);
    expect(hydration("/schedules/new")).toEqual([
      "react-error",
      "418",
      "/schedules/new",
    ]);
    expect(
      hydration("/schedules/0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d/edit"),
    ).toEqual(["react-error", "418", "/schedules/[id]/edit"]);
  });

  it("leaves other errors filtered and grouped by stack", () => {
    const event = beforeSend({
      transaction: "/",
      exception: { values: [{ type: "Error", value: "Network failed" }] },
    }) as {
      fingerprint?: string[];
      exception: { values: { value: string }[] };
    };

    expect(event.exception.values[0]?.value).toBe("[Filtered error]");
    expect(event.fingerprint).toBeUndefined();
  });
});
