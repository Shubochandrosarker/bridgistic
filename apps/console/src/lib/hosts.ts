/** Marketplace is a public catalog. Customer accounts live on the dashboard. */
export const DASHBOARD_ORIGIN = "https://dashboard.bridgistic.app";

export function isMarketplaceHost(hostname: string): boolean {
  return hostname === "marketplace.bridgistic.app" || hostname.startsWith("marketplace.");
}

export function isPublicMarketplacePath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/marketplace" ||
    pathname === "/pro" ||
    pathname === "/install-guide" ||
    pathname === "/docs/install" ||
    pathname.startsWith("/marketplace/")
  );
}

/** Map a marketplace URL onto the customer dashboard. */
export function dashboardUrlFor(pathname: string, search = "", hash = ""): string {
  let dest = pathname;
  if (pathname === "/signin" || pathname === "/signup" || pathname === "/sign-in") dest = "/sign-in";
  else if (pathname === "/installed" || pathname === "/profile" || pathname === "/settings") dest = "/";
  return `${DASHBOARD_ORIGIN}${dest}${search}${hash}`;
}
