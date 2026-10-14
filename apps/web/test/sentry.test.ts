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
});
