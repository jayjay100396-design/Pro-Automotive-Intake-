# Rules for Gemini & Claude: Stellar Glass (`stellar-glass-jobs`)

## What this project is
- **Stellar Glass**: estimating, drawing takeoffs, proposals, contracts and change orders, AIA G702/G703 pay apps, invoices and payments, the schedule, supplier parts orders and the public quote page for Wesley ("Wes") Stel's glass business (Stel, one l) in Lakeland, FL.
- **Live site**: `https://stellar-glass-jobs.web.app`
- **Firebase project**: `stellar-glass-jobs`
- **GitHub remote**: `jayjay100396-design/Pro-Automotive-Intake-` (despite the historical repo name, this repository is **only** Stellar Glass, **never** Pro Automotive).
- **This repository is public.** Never commit secrets, API keys, `.env.*` files, or personal details (personal emails, notary commission numbers, customer records). Settings like these belong in the app (Firestore, members only) or in the deploying computer's local files.
- **Main app branch**: `claude/project-thread-5lc6hk` (draft PR #1). Work goes on its own branch with a pull request into it; the live site is deployed from its head.

## Projects on Jason's Mac (strict firewall, never mix them)
1. **Stellar Glass (this project)**: Firebase project `stellar-glass-jobs`. Gemini's working copy is `/Users/Jay/.gemini/antigravity-ide/scratch/stellar-glass`. The old copies in `~/Downloads/stellar-glass-*` and `_archive-stellar-glass-prototype-2026-10-09` are locked (`do-not-deploy-old-copy`): never edit or deploy from them.
2. **Pro Automotive (do not touch from here)**: folder `/Users/Jay/.gemini/antigravity-ide/scratch/dynamic-workload-calendar`, Firebase project `pro-automotive-calendar`. Never read, edit or deploy it from a Stellar Glass task.
3. **Family Hub (do not touch from here)**: folder `/Users/Jay/.gemini/antigravity-ide/scratch/family-hub`, Firebase project `family-hub-jay-2026`. Never read, edit or deploy it from a Stellar Glass task.

## Codebase map (`public/` and `functions*/`)
- `public/index.html` with `public/js/app.js` and `public/css/app.css`: the signed-in app (sign-in, router, sidebar). Views live in `public/js/views.js`, `schedule.js`, `parts.js`, `suppliers.js`, `website.js`, `accounting.js` and `takeoff/page.js`.
- `public/quote.html` with `public/js/site.js` and `public/css/site.css`: the public quote request page.
- `public/js/calc.js`: money math (proposals, contracts, change orders, G702/G703, invoices, payments) and storefront sizing. `accounting-calc.js`: lien waivers and ledger exports.
- `public/js/print.js`, `proposal-doc.js`, `proposal-send.js`: printed documents, the proposal PDF and Send to customer.
- `public/js/files.js`: job files in Cloud Storage folders `photos`, `plans`, `documents`, `forms` and `other`, and Google Drive copies.
- `public/js/billing.js`, `payments.js`: deposits, payments and Stripe invoices (online payments stay off until the Stripe functions are deployed).
- `public/js/parts.js`, `parts-email.js`, `suppliers.js`, `supplier-plugins.js`: supplier quote requests and orders.
- `public/js/takeoff/`: drawing takeoff (PDF reader, measuring, Read with Gemini, DXF reader, 3D viewer).
- `public/sw.js`, `public/js/pwa.js`, `public/manifest.webmanifest`: the installable desktop app.
- `firestore.rules`, `storage.rules`: security rules (tests in `test/*.rules.test.js`).
- Cloud Functions, one codebase per feature: `functions/` (`default`, Stripe), `functions-calendar/` (`calendar`), `functions-alerts/` (`alerts`), `functions-parts/` (`parts`).

## Verification and deploy rules
- After editing any `.js` file, run `node --check <file>`. `npm test` runs every test (the rules tests on the emulators and each functions folder's tests); `npx mocha "test/*.test.mjs"` runs only the browser-code unit tests.
- **Ask Jay before every deploy** and wait for an explicit yes for that deploy. Local tools (Gemini) also ask before every `git push`, and push to a feature branch, not straight to the main app branch.
- **Never run a bare `firebase deploy`**: it also deploys every functions codebase, including ones still waiting on their secrets. Use the npm scripts: `npm run deploy` (hosting and rules), `deploy:rules`, `deploy:functions` (Stripe), `deploy:calendar`, `deploy:alerts`, `deploy:parts`.
- Deploy from a fresh pull of `claude/project-thread-5lc6hk`. `scripts/deploy-guard.sh` runs before every deploy target (`firebase.json` `predeploy`) and refuses a deploy that isn't to `stellar-glass-jobs`, isn't named with `--only`, isn't a clean checkout at the exact head of that branch on GitHub, or fails the unit tests. Never remove or bypass it.
