# Hatzolah Air public website starter — handoff for Claude / Claude Code

This folder is a **standalone public website starter** for `hatzolahair.org.il`.
Do not deploy or change DNS automatically. Aaron wants to review and iterate first.

## What already exists

- `index.html` — new public homepage.
- `request-flight.html` — branded bridge to the **existing secure CRM public intake form**.
- `donate.html` — incorporates the previously created Hatzolah Air donation page, including Israeli Section 46 and U.S. 501(c)(3) routes.
- `assets/styles.css` — shared homepage/request styles using Hatzolah Air navy + lime branding.
- `assets/site.js` — central place to change CRM/request URLs.
- `assets/favicon.svg` — simple temporary brand favicon.

## Existing CRM — do not duplicate it

The CRM is a separate Next.js/Vercel application and already has a live public inquiry route at `/request`.
The public website should **link to that intake flow**, not reimplement the medical form in this static project.

Current links used here:

- Staff CRM: `https://app.adler-md.com`
- Public flight request: `https://app.adler-md.com/request`

Planned future links after DNS is ready:

- Staff CRM: `https://app.hatzolahair.org.il`
- Public flight request: `https://app.hatzolahair.org.il/request`

When the new subdomain is ready, update `assets/site.js` only.

## Design direction

Use the U.S. Hatzolah Air site as brand inspiration, not as a page to clone. Keep the site:

- visually strong and aviation-oriented;
- navy + Hatzolah lime, with generous whitespace;
- much less busy than a fundraising campaign site;
- focused on three public actions: **Request a Flight**, **Understand What We Do**, **Donate**;
- responsive and accessible;
- English-first for this first version, with a Hebrew version to be built as a deliberate second step rather than machine-translating the finished copy.

## Organization naming

Use **Hatzolah Air** in fresh public-facing copy. For legal/tax references, `Hatzolah Air (R.A.)` and Amuta `580731198` are intentionally retained.

## Important content constraints

Do not invent:

- mission counts, annual flight counts, response times or survival claims;
- phone numbers or email addresses;
- aircraft currently in service unless explicitly confirmed;
- partner endorsements;
- promises that a submitted request will be accepted.

The flight-request page deliberately says that submission begins review and does not guarantee mission acceptance or aircraft availability.

## Before production launch

Still needed:

1. Confirm public contact email/phone and mailing/contact presentation.
2. Add real approved photography/video and the official production logo files.
3. Decide whether to create full About / Fleet / News / Volunteer pages.
4. Create a proper Hebrew version with RTL design.
5. Add reviewed Privacy Policy / Terms / accessibility statement as appropriate.
6. Change the CRM link to `app.hatzolahair.org.il` once that DNS/subdomain is configured.
7. Final mobile, accessibility, SEO and legal copy review.

## How to preview locally

Open `index.html` directly, or serve the folder locally:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

## Suggested deployment later

This starter is plain HTML/CSS/JS and can be deployed easily to Vercel, Cloudflare Pages, Netlify, GitHub Pages, or converted to a Next.js/Astro project. For Aaron's workflow, continue editing in Claude/Claude Code first, then deploy only after approval.

## Jerusalem Flight Day (`/flight-day`)

Unlisted, `noindex` donor registration page for the helicopter flight day on
Thu 1 Oct 2026 at the Herzog Medical Center helipad. Files: `flight-day.html`,
`assets/flight-day.{css,js}`, `src/flight-day.js` (API), `src/mail.js`.

- 23 slots, every 20 min 10:00–17:40, 14:20 left out as a break; 8 seats each.
  Schedule/date live in `EVENT`/`SLOTS` in `src/flight-day.js` (mirrored in
  `assets/flight-day.js` as a fallback).
- Each booking → a subfolder (passport files + a "Booking summary" Google Doc)
  inside Drive folder `FLIGHT_DAY_DRIVE_FOLDER_ID` (set in `wrangler.jsonc`).
- Seat counts + booking records: KV namespace `hatzolah-flight-day` (binding `FLIGHT_DAY`).
- Ops manifest CSV: `/api/flight-day/manifest?key=<FLIGHT_DAY_ADMIN_KEY>`.

Worker secrets needed (`wrangler secret put …`):
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`
(same values as the CRM's uploads — that Google account must have edit access to
the Drive folder), `FLIGHT_DAY_ADMIN_KEY`, optionally `FLIGHT_DAY_NOTIFY_EMAIL`.
Emails reuse `GMAIL_USER` / `GMAIL_APP_PASSWORD`.
