# Stellar Glass: Stripe setup

Stripe lets Wes's customers pay an invoice online by card or bank transfer, with every line of the proposal on the bill.

## How it works in the app

1. **Proposal to invoice.** On a proposal (Estimates page), set the **Deposit** under Terms: a percent of the price (50% to start), a dollar amount, or 0 for none. The printed proposal states it, for example "A 50% deposit ($1,302.09) is required before materials can be ordered." The **Billing** card below makes a **deposit invoice** for that amount or a **final invoice**. Each proposal line becomes an invoice line, priced the way the printed proposal shows it, so the invoice adds up to the proposal total and the same sales tax. Lines the proposal marks not taxable (like labor) stay tax-free, and every invoice line has a **Tax** checkbox. A final invoice subtracts any deposit invoices. A lump-sum price (Price 2, for example) becomes one line with its specs.
2. **Invoice to Stripe.** On the invoice, the **Online payment** card has **Email it with Stripe** and **Get a payment link**. The app's server code (a Cloud Function) creates a Stripe invoice with the same number, the same lines and the sales tax, and Stripe emails the customer a **Pay** button. Pay apps already make invoices, so they work the same way.
3. **Paid.** When the customer pays, Stripe tells the app and the invoice turns **Paid** with the payment date. **Check payment** asks Stripe directly. If a check comes instead, **Mark paid** also cancels (voids) the Stripe invoice so nobody pays twice. If an invoice changes after it was sent, the card says so: void the Stripe invoice and send it again (Stripe numbers the new one 1003-2).
4. **Where each job stands.** The proposal's Billing card shows the price, what's been paid and the balance, with a **Paid**, **Partly paid** or **Unpaid** badge. The Estimates list shows the same badge in its Payment column, and every invoice made from a proposal says how much of the proposal is paid. On Stripe's payment page (the link the customer opens), the invoice lists the proposal total, what was paid before, this invoice and what's left after it, and Stripe marks the page **Paid** once it's paid.

Only the owner, admins, staff and the accountant can send or void Stripe invoices. The Stripe key lives in Google Secret Manager and only the server code can read it; it is never in the app's web pages or in this repo.

## What it costs

Stripe has no setup or monthly fee. Standard US pricing (checked 2026-10-09 at <https://stripe.com/pricing>):

| Per paid invoice | Fee |
|---|---|
| Stripe Invoicing | 0.4% of the invoice |
| Paid by card | 2.9% + 30¢ |
| Paid by bank (ACH Direct Debit) | 0.8%, at most $5 |

A $5,000 shower paid by bank costs $5 + $20 = $25; paid by card, $145.30 + $20 = $165.30. On big commercial pay apps, bank payment or a mailed check is far cheaper than a card.

Firebase: the server code needs the **Blaze** (pay as you go) plan. At Wes's volume it stays inside the free allowances (2 million function calls and 6 stored secrets a month), so expect $0, or a few cents a month for storing the server code. Keep the $5 budget alert on.

## Setup

Start in Stripe's **test mode** (Stripe calls it a sandbox). Nothing real is charged, and you can switch to live at the end.

### A. Stripe (in the browser, signed in to Wes's Stripe account)

1. **Create the account** at <https://dashboard.stripe.com/register> with Wes's business email. It should be Stellar Glass LLC's own account, because payouts go to its bank. Test mode works before the business details are filled in.
2. **Branding:** Settings > Business > Branding. Upload the logo and set the colors to navy `#123764` and blue `#0071bc`. These show on Stripe's invoice emails, invoice PDFs and payment page.
3. **Payment methods:** Settings > Payments > Payment methods. Keep **Cards** on and turn on **ACH Direct Debit** (bank), which is much cheaper on large invoices.
4. **Invoice emails (optional):** Settings > Billing > Invoices and customer emails. Turn on payment receipts, and reminders for unpaid invoices if you want Stripe to nudge customers.
5. **API key:** Developers > API keys > **Create restricted key**. Name it `Stellar Glass app`, set **Customers: Write** and **Invoices: Write**, leave everything else at None, and create it. Copy the key (it starts with `rk_test_`). Don't paste it into chat, email or a document.
6. **Webhook:** Developers > Webhooks > **Add destination** (older dashboards say Add endpoint).
   - Events: `invoice.paid`, `invoice.voided`, `invoice.marked_uncollectible`
   - Destination type: Webhook endpoint
   - URL: `https://us-central1-stellar-glass-jobs.cloudfunctions.net/stripeWebhook`

   Then open the new destination and copy its **signing secret** (it starts with `whsec_`).

### B. Firebase (Jason)

7. **Blaze plan:** <https://console.firebase.google.com/project/stellar-glass-jobs/usage/details>, then Modify plan > Blaze, and set a $5 budget alert.
8. **Store the two Stripe secrets** from Terminal on the Mac, in the app's folder (the one used to deploy). Each command asks for the value at a hidden prompt; paste it and press Enter:

   ```bash
   npx firebase functions:secrets:set STRIPE_SECRET_KEY       # paste the rk_test_ key
   npx firebase functions:secrets:set STRIPE_WEBHOOK_SECRET   # paste the whsec_ secret
   ```

9. **Deploy** (Claude can do this from the Mac):

   ```bash
   npm install                  # also installs the server code's packages (functions/)
   npm test
   npm run deploy               # rules, indexes and the web app
   npm run deploy:functions     # the Stripe server code
   ```

   The first functions deploy asks for **STRIPE_COMPANY_ID**: the Business ID shown in the app under **Settings > Online payments**. The deploy saves it in `functions/.env.stellar-glass-jobs`. (A deploy that can't ask, like one Claude runs, needs that file first, holding the line `STRIPE_COMPANY_ID=` plus the ID. It isn't a secret, so it can be committed.) Only that business can use the Stripe account, so a stranger who signs up for their own business in the app can't bill through Wes's Stripe.

### C. Try it, then go live

10. In the app, **Settings > Online payments** should say **Connected to Stripe (test mode: nothing is really charged)**.
11. Open a proposal, choose **Final invoice** in the Billing card, then on the invoice choose **Email it with Stripe** with your own email on the customer (in test mode Stripe only emails people on your Stripe team, so use the email you sign in to Stripe with). Open Stripe's email, press Pay, and use test card `4242 4242 4242 4242` with any future date and any CVC. The invoice turns **Paid** in the app within a few seconds.
12. **Go live:** activate the Stripe account (Settings > Business: business details, EIN and the bank account for payouts). In live mode, repeat steps 5 and 6, run step 8 again with the live key (`rk_live_`) and the live signing secret, then run `npm run deploy:functions` again. Customers and invoices made in test mode stay in test mode.

## If something's wrong

The app shows these on the invoice or in Settings:

- **Online payments aren't set up yet**: the functions aren't deployed (step 9).
- **Stripe rejected the API key** or **needs Customers and Invoices set to Write**: redo step 5, then step 8 and step 9.
- **Stripe is set up for a different business**: `STRIPE_COMPANY_ID` in `functions/.env.stellar-glass-jobs` doesn't match the Business ID in Settings. Fix it and run `npm run deploy:functions`.
- **Paid in Stripe but not in the app**: press **Check payment** on the invoice, then check the webhook in Stripe (Developers > Webhooks) for failed deliveries.

## For developers

- Server code: `functions/` (Node 22, firebase-functions 6 with the v2 API; it stays on 6 because the Firebase CLI in `package.json`, 13.x, can't run version 7 in the emulator). `stripeInvoices` is a callable function with actions `status`, `create`, `void` and `sync`; `stripeWebhook` receives Stripe's events, checks the signature, re-reads the invoice from Stripe and updates Firestore.
- The function writes `stripe` (invoice status, Stripe invoice id, payment link, PDF) on `companies/{id}/invoices/{id}` and `stripeCustomerIds` on customers. The Firestore rules stop the app from writing those fields, so only the server can.
- The deposit is `depositType` (`percent` or `amount`) and `depositValue` on the estimate (`calc.js` `proposalDeposit`). Proposals saved before those fields existed take the percent from their typed terms and print their terms as typed until they're saved again. Invoices made from a proposal carry `estimateId`, `proposalNumber` and `proposalPrice`; when the function creates the Stripe invoice, it puts the proposal total, the amount already paid (other paid invoices from that proposal), this invoice and the balance left at the top of the Stripe invoice's memo, ahead of the invoice notes.
- Line items: whole quantities with whole-cent prices go to Stripe as quantity × unit price; anything else goes as one amount with the quantity in the description, so Stripe's total always matches the app's to the cent. Sales tax is its own line. The Stripe invoice gets the app's invoice number; if Stripe refuses it (already used), Stripe numbers it and the app's number goes in an "Invoice #" custom field.
- Local testing: `npm run dev:stripe` runs the emulators with the functions. Put test keys in `functions/.secret.local` (`STRIPE_SECRET_KEY=...`, `STRIPE_WEBHOOK_SECRET=...`); `functions/.env.demo-stellar-glass` lets any business use Stripe in the emulator only. To run without a Stripe account, start [stripe-mock](https://github.com/stripe/stripe-mock) and add `STRIPE_MOCK_HOST=127.0.0.1:12111` to `functions/.env.local`. Both local files are in `.gitignore`.
- `npm test` covers the money math, the Stripe line items, the server logic (against the Firestore emulator with a fake Stripe) and the rules.
