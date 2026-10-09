# Stellar Glass

Job tracking and billing for Stellar Glass (Wes Stel): customers and jobs, estimates, contracts, change orders, AIA G702/G703 pay apps and invoices. Runs on Firebase (Authentication + Firestore + Hosting), with no build step.

- **Sign-in:** email and password, Google, or phone (SMS code).
- **Estimates:** storefront and shower templates, glass billed by square foot with a per-lite minimum, markup, minimum charge, tax on taxable lines, printable quote.
- **Contracts:** created from an accepted estimate, with a schedule of values that feeds the pay apps.
- **Change orders:** add or deduct scope; approved ones update the contract sum.
- **Pay apps:** G703 continuation sheet (previous, this period, stored, %, balance, retainage) and G702 summary, printable with a notary block.
- **Invoices:** simple invoices or one click from a pay app; paid and unpaid tracking.
- **Team:** invite links for admin, staff or the accountant (reads everything, handles pay apps and invoices); change roles, remove people, transfer ownership.

## Layout

| Path | What |
|---|---|
| `public/` | The web app (plain ES modules; Firebase SDK from the official CDN) |
| `public/js/calc.js` | Estimate, invoice and G702/G703 math (unit tested) |
| `firestore.rules` | Security rules: company-scoped data and roles |
| `test/` | Rules tests (emulator) and money-math tests |
| `FIREBASE_SETUP.md` | Console steps, deploy and local dev |

`npm run dev` runs it locally against emulators; `npm test` runs the tests; `npm run deploy` publishes.
