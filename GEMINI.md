# Rules for Gemini & Claude: Stellar Glass (`stellar-glass-jobs`)

## What this project is
- **Stellar Glass** — commercial & residential glazing estimator, blueprint takeoff, job tracker, schedule, supplier/Trulite parts orders, proposals, and Stripe billing for Wesley ("Wes") Stell.
- **Live site**: `https://stellar-glass-jobs.web.app`
- **Firebase project**: `stellar-glass-jobs`
- **Canonical folder**: `/Users/Jay/.gemini/antigravity-ide/scratch/stellar-glass` (also symlinked at `/Users/Jay/.gemini/antigravity/scratch/stellar-glass` and `/Users/Jay/Downloads/stellar-glass`).
- **GitHub remote**: `jayjay100396-design/Pro-Automotive-Intake-` (note: despite the historical GitHub repo name, this repository is **ONLY** for Stellar Glass, **NEVER** Pro Automotive).

## Projects on this Mac (Strict Firewall — Never Mix Them)
1. **Stellar Glass (THIS PROJECT)**:
   - Folder: `/Users/Jay/.gemini/antigravity-ide/scratch/stellar-glass`
   - Firebase project: `stellar-glass-jobs`
   - Work **only** in this folder when working on Stellar Glass.
   - All old copies in `~/Downloads/stellar-glass-*` and `_archive-stellar-glass-prototype-2026-10-09` are locked (`do-not-deploy-old-copy`). Never edit or deploy from them.
2. **Pro Automotive (DO NOT TOUCH FROM HERE)**:
   - Folder: `/Users/Jay/.gemini/antigravity-ide/scratch/dynamic-workload-calendar`
   - Firebase project: `pro-automotive-calendar`
   - **Never** read, edit, or deploy Pro Automotive from a Stellar Glass task.
3. **Family Hub (DO NOT TOUCH FROM HERE)**:
   - Folder: `/Users/Jay/.gemini/antigravity-ide/scratch/family-hub`
   - Firebase project: `family-hub-jay-2026`
   - **Never** read, edit, or deploy Family Hub from a Stellar Glass task.

## Codebase Map (`public/` & `functions*/`)
- `public/index.html` — public marketing & quote request site (`public/js/site.js`, `public/css/site.css`).
- `public/app.html` — authenticated staff workspace (`public/js/app.js`, `public/css/app.css`).
- `public/takeoff.html` — blueprint & CAD takeoff viewer (`public/js/takeoff/page.js`, `takeoff.js`, `reader.js`, `measure.js`, `dims.js`, `vision.js`, `gemini.js`).
- `public/js/calc.js` — pure math & pricing engine (proposals, glass/framing/storefront calculations, pay apps).
- `public/js/views.js` — Jobs, Proposals, Pay Apps, Schedule, Requests, Suppliers, Settings views.
- `public/js/files.js` — job file upload, categorization (`plans`, `specs`, `contracts`, `photos`), preview modal.
- `public/js/parts.js`, `parts-email.js`, `suppliers.js`, `supplier-plugins.js` — supplier quotes & Trulite glass/framing orders.
- `public/js/billing.js`, `payments.js`, `proposal-doc.js`, `proposal-send.js` — Stripe invoices & proposal PDF delivery.
- `functions/`, `functions-calendar/`, `functions-alerts/`, `functions-parts/` — Cloud Functions codebases.

## Verification & Deploy Rules
- Run `pwd -P` first to confirm you are in `/Users/Jay/.gemini/antigravity-ide/scratch/stellar-glass`.
- After editing any `.js` file, run `node --check <file>` and `npm test`.
- `scripts/deploy-guard.sh` runs automatically before every `firebase deploy` via `firebase.json` `predeploy`. Never remove or bypass it.
- **Ask Jay before every `firebase deploy` or `git push`**, and wait for an explicit yes.
