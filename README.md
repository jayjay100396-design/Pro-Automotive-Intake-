# Stellar Glass

Job tracking and billing for Stellar Glass (Wes Stel): customers and jobs, estimates, contracts, change orders, AIA G702/G703 pay apps and invoices. Runs on Firebase (Authentication + Firestore + Storage + Hosting), with no build step.

- **Sign-in:** email and password, or Google. Phone sign-in (SMS code) is built in but turned off: `PHONE_SIGN_IN` in `public/js/auth.js`.
- **Estimates:** storefront and shower templates, glass billed by square foot with a per-lite minimum, markup, minimum charge, tax on taxable lines, printable quote.
- **Contracts:** created from an accepted estimate, with a schedule of values that feeds the pay apps.
- **Change orders:** add or deduct scope; approved ones update the contract sum.
- **Pay apps:** G703 continuation sheet (previous, this period, stored, %, balance, retainage) and G702 summary, printable with a notary block.
- **Invoices:** simple invoices or one click from a pay app; paid and unpaid tracking.
- **Files:** photos, plans, contracts, permits and forms on each job, sorted by category and searchable, with an optional copy in each person's Google Drive (`Stellar Glass Jobs / customer / job`).
- **Quote requests:** a public page at `/quote` (no sign-in) where customers send a request with photos or plans; it lands under Requests, and one click turns it into a customer and a lead job. The **Website** page lets the owner or an admin upload the page's photos and gallery.
- **Request emails:** each quote request is emailed to Wes (or whoever Settings names) with the customer's details and photos attached; replying answers the customer. See `EMAIL_ALERTS.md`.
- **Parts orders:** quote requests and orders to suppliers. Start one from a job or a proposal, paste a list (Wes's typed Trulite lists, a spreadsheet or glass sizes like `4 @ 35 7/8 x 83 3/4`), attach the job's files, and send it from the app, Gmail or the email app; the email carries the job, PO, account number, need date and delivery. Each order is then tracked through quoted, ordered, confirmed, shipped and received, with late orders flagged, what's come in, follow-up emails and its history. **Suppliers** holds who the business buys from; supplier plugins (Trulite, C.R. Laurence, a glass fabricator, any other) fill in branches and how they like requests.
- **Team:** invite links for admin, staff or the accountant (reads everything, handles pay apps and invoices); change roles, remove people, transfer ownership.

## Layout

| Path | What |
|---|---|
| `public/` | The web app (plain ES modules; Firebase SDK from the official CDN) |
| `public/js/calc.js` | Estimate, invoice and G702/G703 math (unit tested) |
| `public/quote.html`, `js/site.js`, `css/site.css` | The public quote request page; `js/requests.js` is the Requests screen in the app and `js/website.js` the Website photos page |
| `public/js/files.js`, `drive.js` | Job files (Cloud Storage) and the Google Drive copies |
| `public/js/parts.js`, `suppliers.js`, `supplier-plugins.js`, `parts-email.js` | Parts orders and their tracking, Suppliers, the supplier plugins, and the parts lists and supplier emails (shared with the server) |
| `firestore.rules`, `storage.rules` | Security rules: company-scoped data, files and roles |
| `functions-alerts/` | Cloud Functions: the quote request emails and parts requests sent from the app (their own codebase, `alerts`) |
| `test/`, `functions-alerts/test/` | Rules tests (emulator), money-math tests, email and parts list tests |
| `FIREBASE_SETUP.md` | Console steps, deploy and local dev |
| `EMAIL_ALERTS.md` | Turning on the quote request emails, and sending parts requests from the app |

`npm run dev` runs it locally against emulators; `npm test` runs the tests; `npm run deploy` publishes.
