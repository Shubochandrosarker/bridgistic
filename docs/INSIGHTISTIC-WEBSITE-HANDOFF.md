# Insightistic website rebuild handoff

## Repository boundary

The requested Insightistic WordPress theme rebuild cannot be implemented in
this repository. This checkout is the Bridgistic application monorepo; its
root package is `bridgistic-app`, and `apps/web` is reserved for the future
`bridgistic.app` static marketing surface. No Insightistic WordPress theme,
WordPress templates, or the referenced `insightistic-website.zip` are present
in this checkout.

Do not copy Insightistic theme code into `apps/web`: doing so would mix two
independently deployed products and bypass the established WordPress release
path.

## Required source checkout

Continue the rebuild in a checkout of
`Shubochandrosarker/insightistic-website`, or provide the referenced archive in
the workspace. Before editing, verify that the source includes the expected
theme entry points:

- `functions.php` and `theme.json`
- `front-page.php`, `page.php`, `single.php`, `archive.php`, `search.php`, and
  `404.php`
- `inc/seo.php`
- `template-parts/global/navbar.php` and
  `template-parts/global/footer-main.php`
- `assets/css/theme.css` and `assets/css/responsive.css`

The source archive must be unpacked into its own Git repository so changes,
tests, deployment history, and rollback remain attributable to the
Insightistic website.

## External facts that must remain configurable

The implementation must not infer or fabricate legal or commercial facts.
Confirm and configure these values before production deployment:

- legal entity name, registered address, governing law, and legal contact;
- privacy and data-protection contact details;
- refund/cancellation rules and effective dates;
- current subprocessors and data locations;
- approved social and ecosystem profile URLs;
- canonical app, dashboard, support, billing, and checkout URLs; and
- Paddle onboarding status.

Until Paddle onboarding is confirmed as complete, checkout copy must describe
the integration without claiming that production payments are live.

## Acceptance gate for the website repository

The website change is ready to deploy only after its own repository records:

1. PHP lint results for every changed PHP file.
2. Escaping and URL-validation checks for templates and configurable links.
3. A route crawl covering status, canonical URL, metadata, robots directives,
   structured data, breadcrumbs, headings, and broken links.
4. XML validation for all sitemap endpoints and output checks for
   `robots.txt`, `llms.txt`, and `llms-full.txt`.
5. Keyboard, focus, contrast, and responsive checks on representative mobile,
   tablet, and desktop routes.
6. Confirmation that SEO-plugin detection prevents duplicate metadata and
   schema output.
7. A test-mode checkout traversal with no charge and no unsupported payment
   claim.
8. A post-deployment cache purge and production recrawl through the existing
   Hostinger/WordPress release process.

This handoff documents the source boundary only. It does not represent a
completed Insightistic website rebuild or a deployable theme change.
