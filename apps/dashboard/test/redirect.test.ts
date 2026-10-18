import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS Pages Function
import { redirectFor } from "../functions/_middleware.js";

describe("app.bridgistic.app → dashboard.bridgistic.app", () => {
  it("keeps path and query", () => {
    expect(redirectFor("https://app.bridgistic.app/approvals?id=apr_1&x=2")).toBe("https://dashboard.bridgistic.app/approvals?id=apr_1&x=2");
    expect(redirectFor("https://app.bridgistic.app/")).toBe("https://dashboard.bridgistic.app/");
  });
  it("leaves the main and preview hosts alone", () => {
    expect(redirectFor("https://dashboard.bridgistic.app/sites")).toBeNull();
    expect(redirectFor("https://fix-x.bridgistic-dashboard.pages.dev/")).toBeNull();
  });
});
