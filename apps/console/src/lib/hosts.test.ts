import { describe, expect, it } from "vitest";
import { dashboardUrlFor, isMarketplaceHost, isPublicMarketplacePath } from "./hosts";

describe("marketplace host roles", () => {
  it("recognizes the public marketplace host", () => {
    expect(isMarketplaceHost("marketplace.bridgistic.app")).toBe(true);
    expect(isMarketplaceHost("admin.bridgistic.app")).toBe(false);
    expect(isMarketplaceHost("dashboard.bridgistic.app")).toBe(false);
  });

  it("keeps only catalog pages on the marketplace host", () => {
    expect(isPublicMarketplacePath("/")).toBe(true);
    expect(isPublicMarketplacePath("/pro")).toBe(true);
    expect(isPublicMarketplacePath("/marketplace/wordpressistic/seo")).toBe(true);
    expect(isPublicMarketplacePath("/schedules")).toBe(false);
    expect(isPublicMarketplacePath("/signin")).toBe(false);
    expect(isPublicMarketplacePath("/installed")).toBe(false);
  });

  it("sends account and dashboard routes to dashboard.bridgistic.app", () => {
    expect(dashboardUrlFor("/schedules")).toBe("https://dashboard.bridgistic.app/schedules");
    expect(dashboardUrlFor("/signin")).toBe("https://dashboard.bridgistic.app/sign-in");
    expect(dashboardUrlFor("/installed")).toBe("https://dashboard.bridgistic.app/");
  });
});
