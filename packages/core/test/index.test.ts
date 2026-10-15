import { describe, expect, it } from "vitest";
import { packageName } from "../src/index.js";

describe("core package scaffold", () => {
  it("exports its package identity", () => {
    expect(packageName).toBe("@recurmail/core");
  });
});
