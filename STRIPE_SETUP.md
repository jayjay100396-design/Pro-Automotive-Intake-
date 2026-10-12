# Stellar Glass: Stripe setup

Stripe lets Wes's customers pay an invoice online by card or bank transfer, with every line of the proposal on the bill.

## How it works in the app

1. **Proposal to invoice.** On a proposal (Estimates page), set the **Deposit** under Terms: a percent of the price (50% to start), a dollar amount, or 0 for none. The printed proposal states it, for example "A 50% deposit ($1,302.09) is required before materials can be ordered." The **Billing** card below makes a **deposit invoice** for that amount or a **final invoice**. Each proposal line becomes an invoice line, priced the way the printed proposal shows it, so the invoice adds up to the proposal total and the same sales tax. Lines the proposal marks not taxable (like labor) stay tax-free, and every invoice line has a **Tax** checkbox. A final invoice subtracts any deposit invoices. A lump-sum price (Price 2, for example) becomes one line with its specs.
2. **Invoice to Stripe.** Online payments stay off until the owner ticks **Let customers pay invoices online with Stripe** under **Settings > Online payments**, which only turns on once Stripe is connected. Then, on the invoice, the **Online payment** card has **Email it with Stripe** and **Get a payment link**. The app's server code (a Cloud Function) creates a Stripe invoice with the same number, the same lines and the sales tax, and Stripe emails the customer a **Pay** button. An invoice dated before the day it's sent keeps its date as the Stripe invoice's date of issue. Pay apps already make invoices, so they work the same way.
3. **Paid.** When the customer pays, Stripe tells the app and the invoice turns **Paid** with the payment date. Paid for real (live mode), it then stays as it was paid, like Stripe's receipt: it can't be edited or deleted, and its printout keeps the customer and job details it was billed with. **Check payment** asks Stripe directly. If a check comes instead, record it on the invoice's **Payments** card: that cancels (voids) the Stripe invoice first, after asking, so nobody pays twice. While a live Stripe invoice can still be paid, the invoice can't be edited, so a payment can't mark a different bill paid: to change it, void the Stripe invoice, edit the invoice, and send it again (Stripe numbers the new one 1003-2). If the job or customer changes after it was sent, the card says so. A credit note on an open Stripe invoice (in Stripe's dashboard) takes that much off what it asks for, and the app counts the lower amount as owed. If a customer pays more than the invoice asks for, Stripe keeps the extra as credit for their next invoice, so the app counts it there, not twice. To give money back on an invoice paid through Stripe, open it in Stripe and choose **More actions > Issue a credit note** with a refund, rather than refunding from the Payments page, so the refund is tied to the invoice. The app then shows it and counts only what's left as paid. An invoice marked **uncollectible** in Stripe can still be paid, so the app keeps it linked until you void it (from the invoice's Online payment card) and send a new one. If a customer has credit on their Stripe account (say a credit note credited their balance instead of refunding), Stripe uses it on their next invoice: the card shows how much came off, and when the credit covers the whole invoice, Stripe marks it paid right away and there's nothing to email. If the app has to cancel one of those (say the invoice was changed on another device while it was being sent), it gives the credit back to the customer's Stripe account with a credit note, without emailing them.
4. **Cash, check or other.** Every invoice has a **Payments** card, with or without Stripe: pick **Cash**, **Check** or **Other**, then the amount, the date it came in, the check number or a reference, and a note. The invoice shows **Partly paid** until its payments cover it, then turns **Paid** on the latest payment's date. Choosing **Paid** in the invoice's Status field records a payment for what's left. Payments keep their amounts, so editing an invoice afterwards doesn't change what was paid (the invoice goes back to partly paid if it now comes to more). The owner and admins can remove a payment entered by mistake; staff and the accountant can only add them. An invoice with payments recorded can't also go out with Stripe, since Stripe would ask for the whole amount; make a new invoice for what's left instead. The printed invoice lists each payment and the balance due.
5. **Where each job stands.** The proposal's Billing card shows the price, what's been paid and the balance, with a **Paid**, **Partly paid** or **Unpaid** badge. The Estimates list shows the same badge in its Payment column, and every invoice made from a proposal says how much of the proposal is paid. On Stripe's payment page (the link the customer opens), the invoice lists the proposal total, what was paid before, this invoice and what's left after it, and Stripe marks the page **Paid** once it's paid. Once a proposal becomes a contract, its pay apps bill the rest of the job: each pay app takes the proposal's deposit off (G702 line 7a, **Less deposit applied**) until it's used up, the proposal's Billing card makes no final invoice, and no more deposit invoices once the first pay app is in.

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

Steps 1 to 3 need Wes. Then he can add Jason on the Team page (<https://dashboard.stripe.com/settings/team>, **Add member**, role **Developer**), so Jason can do steps 4 to 6 himself and the key never has to be sent to anyone. A Developer can make keys and webhooks but can't change the bank account or add people.

1. **Create the account** at <https://dashboard.stripe.com/register> with Wes's business email. It should be Stellar Glass LLC's own account, because payouts go to its bank. Test mode works before the business details are filled in.
2. **Branding:** Settings > Business > Branding. Upload the logo and set the colors to navy `#123764` and blue `#0071bc`. These show on Stripe's invoice emails, invoice PDFs and payment page.
3. **Payment methods:** Settings > Payments > Payment methods. Keep **Cards** on and turn on **ACH Direct Debit** (bank), which is much cheaper on large invoices.
4. **Invoice emails (optional):** Settings > Billing > Invoices and customer emails. Turn on payment receipts, and reminders for unpaid invoices if you want Stripe to nudge customers. Reminders go out for invoices the app emails with Stripe, not for payment links you send yourself.
5. **API key:** Developers > API keys > **Create restricted key**. Name it `Stellar Glass app`, set **Customers: Write**, **Invoices: Write** and **Credit notes: Write** (credit notes are only for giving a customer's credit back when the app cancels an invoice that credit paid). If the page lists **Invoice items** on its own, set it to **Write** too: the app adds each line to the Stripe invoice as an invoice item. Leave everything else at None, and create it. Copy the key (it starts with `rk_test_`). Don't paste it into chat, email or a document.
6. **Webhook:** Developers > Webhooks > **Add destination** (older dashboards say Add endpoint).
   - Events: `invoice.paid`, `invoice_payment.paid`, `invoice.voided`, `invoice.marked_uncollectible`, `credit_note.created`, `credit_note.voided` (`invoice_payment.paid` also comes when a customer pays part of an invoice, so the app shows what's paid so far)
   - Destination type: Webhook endpoint
   - URL: `https://us-central1-stellar-glass-jobs.cloudfunctions.net/stripeWebhook`

   Then open the new destination and copy its **signing secret** (it starts with `whsec_`).

### B. Firebase (Jason)

7. **Blaze plan:** already on since October 9. If the $5 budget alert isn't set yet, add it at <https://console.cloud.google.com/billing> > Budgets & alerts.
8. **Store the two Stripe secrets** from Terminal on the Mac, in the app's folder (the one used to deploy). Each command asks for the value at a hidden prompt; paste it and press Enter:

   ```bash
   npx firebase functions:secrets:set STRIPE_SECRET_KEY       # paste the rk_test_ key
   npx firebase functions:secrets:set STRIPE_WEBHOOK_SECRET   # paste the whsec_ secret
   ```

9. **Deploy** (Claude can do this from the Mac):

   ```bash
   npm install                  # also installs the server code's packages (functions/)
   npm test
   npm run deploy               # Firestore and Storage rules, indexes and the web app
   npm run deploy:functions     # the Stripe server code
   ```

   Only one business in the app can use the Stripe account, so a stranger who signs up for their own business can't bill through Wes's Stripe. That's **STRIPE_COMPANY_ID** in `functions/.env.stellar-glass-jobs`, already set to `KGoWhoXpLaKg0ieruQ2j`: the Stellar Glass business Jason set up on October 9, which the website's quote page also feeds. Before the first functions deploy, check that it matches the Business ID in the app under **Settings > Online payments**. It isn't a secret.

   Wes joins that business with an invite link from Jason (**Settings > Team**, role Admin), and Jason can then hand it over with **Settings > Transfer ownership**. The Business ID stays the same. If Wes signs in without the link, the app makes him a second, empty business instead.

### C. Try it, then go live

10. In the app, **Settings > Online payments** should say **Connected to Stripe (test mode: nothing is really charged)**. The owner then ticks **Let customers pay invoices online with Stripe**, so invoices get the Online payment card.
11. Try it on a made-up customer, so no real bill gets a test payment: add a customer named Test with your own email address, a job for them and a small proposal. Choose **Final invoice** in the proposal's Billing card, then on the invoice choose **Get a payment link** and **Open payment page**. Press Pay and use test card `4242 4242 4242 4242` with any future date and any CVC. The invoice turns **Paid** in the app within a few seconds. Stripe doesn't send invoice emails in test mode, so **Email it with Stripe** only marks the invoice as sent there; emails start in live mode.
12. **Go live:** activate the Stripe account (Settings > Business: business details, EIN and the bank account for payouts). In live mode, repeat steps 5 and 6, run step 8 again with the live key (`rk_live_`) and the live signing secret, then run `npm run deploy:functions` again. Customers and invoices made in test mode stay in test mode. To see Stripe's email, open the Test job, choose **New invoice**, add one small line and save it, choose **Email it with Stripe**, check your inbox, then choose **Void Stripe invoice**. Then delete the Test customer's invoices, proposal, job and customer. A test payment isn't real money, so the app lets you delete those invoices; one paid for real in live mode stays as the record of that payment.

## If something's wrong

The app shows these on the invoice or in Settings:

- **Online payments aren't set up yet**: the functions aren't deployed (step 9).
- **Stripe rejected the API key**: redo step 5, then step 8 and step 9.
- **The Stripe key needs Customers, Invoices and Credit notes set to Write**: in Stripe, open Developers > API keys, click **⋯ > Edit key** on `Stellar Glass app` and set the permission the message names (or all of those in step 5) to Write. The key stays the same, so nothing else needs redoing. **Settings > Online payments** checks the key each time it's opened, and again when the owner turns online payments on.
- **Stripe is set up for a different business**: `STRIPE_COMPANY_ID` in `functions/.env.stellar-glass-jobs` doesn't match the Business ID in Settings. Fix it and run `npm run deploy:functions`.
- **Paid in Stripe but not in the app**: press **Check payment** on the invoice, then check the webhook in Stripe (Developers > Webhooks) for failed deliveries.

## For developers

- Server code: `functions/` (Node 22, firebase-functions 6 with the v2 API; it stays on 6 because the Firebase CLI in `package.json`, 13.x, can't run version 7 in the emulator). `stripeInvoices` is a callable function with actions `status`, `create`, `void` and `sync`; `stripeWebhook` receives Stripe's events (about an invoice, a payment on one including part of it, or a credit note on one), checks the signature, re-reads the invoice from Stripe and updates Firestore. The `status` action lists customers, invoices, invoice items and credit notes (one each), so a permission left at None shows up there; a permission error names the missing permission when Stripe's message does.
- The function writes `stripe` (invoice status, Stripe invoice id, payment link, PDF) on `companies/{id}/invoices/{id}` and `stripeCustomerIds` on customers. The Firestore rules stop the app from writing those fields, so only the server can. If two invoices for a new customer are sent at once, the first Stripe customer saved (in a transaction) is kept and the other is deleted; the kept one is then updated with the second call's details, which may be newer. Before a new Stripe invoice is saved, the function also checks that it shows the customer's email, name, phone and address as they're saved now (Stripe copies them onto the invoice when it's finalized), and cancels it if not.
- `stripe.amountPaid` is what counts as paid: payments, plus the customer's Stripe balance used on the invoice (`ending_balance` minus `starting_balance`), less credit notes after payment and less `amount_overpaid` (Stripe credits an overpayment to the customer's balance, so it counts on the invoice it's used on). `paidOnline` is the payments alone, `overpaid` the overpayment and `balanceApplied` the balance used (negative when a balance they owed was added). `preCredited` is `pre_payment_credit_notes_amount`: it comes off what the bill counts as billed and owed (`calc.js` `creditedOn`, `billedOn`, `dueOn`). A Stripe invoice that credit pays in full when it's finalized is recorded as paid on the spot. Checks re-read the Stripe invoice inside the Firestore transaction, so when two cross, the one saved last has the newest read.
- Sending: the Stripe invoice's id goes in `stripe.pending` on the bill before it's finalized, and stays there until it's saved. A try that fails partway leaves it there, so the next try finds it: it reuses one made from the bill as it is now for the same Stripe customer, and cancels any other (voids it, or for one credit paid, gives the credit back with a credit note to the customer's balance, `email_type: 'none'`). A bill that's edited, paid, voided or deleted while its Stripe invoice is being made gets that invoice cancelled the same way. `effective_at` (midday in Florida on the bill's date) is set only for a bill dated before today; `days_until_due` still counts from the day it's made. If turning on Stripe's reminders fails after the email goes out, the card says so and **Check payment** (or opening the invoice) tries again.
- `onlinePayments: true` on the company document (only the owner can change it, by the rules) turns online payments on. The function refuses to make a new Stripe invoice while it isn't; one already out can still be emailed again, checked or voided.
- Payments recorded by hand are `payments` on the invoice: `[{ id, method: 'cash' | 'check' | 'other', amount, date, ref, note, by, at }]`. What counts as paid is those plus `stripe.amountPaid` (`paidOn` in `calc.js` and `functions/lines.js`); a bill marked paid before payments existed counts its total. The status follows the payments (`billing.js` `withPayments`), saved in a transaction. The rules let only the owner and admins remove or change a payment; others can only add one. The function refuses Stripe for a bill with payments recorded, and the app voids a payable Stripe invoice before recording one.
- While a live Stripe invoice can be paid (open or uncollectible), the rules freeze the invoice (only `updatedAt` changes), like one paid through Stripe. `stripe.party` keeps the customer's and job's details from when the Stripe invoice was made, and the printed invoice uses them once it's paid in live mode.
- **Email it again** re-checks the bill, its job and customer (the email, name, phone and address the Stripe invoice was made with) in the same transaction that notes it as emailed, just before Stripe sends it. Every email is noted before Stripe is asked; if Stripe says it couldn't email it, the note is put back, and if Stripe doesn't answer, it stays (with a note to check Stripe's dashboard) so nobody emails it twice. That transaction also claims the send (`stripe.sending`, removed when Stripe answers; a claim older than the function's timeout is taken over), so two devices emailing it at the same moment send one email and the other is told it's being emailed.
- Pay apps: `payAppSummary` (`views.js`) passes `g702` what the contract's proposal invoices billed (`billedOn`, void ones left out) as the deposit, and line 7a takes it off the current payment due until it's used up.
- The deposit is `depositType` (`percent` or `amount`) and `depositValue` on the estimate (`calc.js` `proposalDeposit`). Proposals saved before those fields existed take the percent from their typed terms and print their terms as typed until they're saved again. Invoices made from a proposal carry `estimateId`, `proposalNumber` and `proposalPrice`, and take the next id in the proposal's own series (`<estimate id>-1`, `-2`, …), made in a transaction only if that id is free, so two people clicking at once make one invoice (`billing.js` `nextProposalId`, `data.js` `putOnce`). When the function creates the Stripe invoice, it puts the proposal total, the amount already paid (other paid invoices from that proposal), this invoice and the balance left at the top of the Stripe invoice's memo, ahead of the invoice notes.
- Line items: whole quantities with whole-cent prices go to Stripe as quantity × unit price; anything else goes as one amount with the quantity in the description, so Stripe's total always matches the app's to the cent. Sales tax is its own line. The Stripe invoice gets the app's invoice number; if Stripe refuses it (already used), Stripe numbers it and the app's number goes in an "Invoice #" custom field.
- Local testing: `npm run dev:stripe` runs the emulators with the functions. Put test keys in `functions/.secret.local` (`STRIPE_SECRET_KEY=...`, `STRIPE_WEBHOOK_SECRET=...`); `functions/.env.demo-stellar-glass` lets any business use Stripe in the emulator only. To run without a Stripe account, start [stripe-mock](https://github.com/stripe/stripe-mock) and add `STRIPE_MOCK_HOST=127.0.0.1:12111` to `functions/.env.local`. Both local files are in `.gitignore`.
- `npm test` covers the money math, the Stripe line items, the server logic (against the Firestore emulator with a fake Stripe) and the rules.
