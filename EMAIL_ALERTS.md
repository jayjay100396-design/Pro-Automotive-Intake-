# Stellar Glass: quote request emails

When a customer sends a request from the quote page (`/quote`), the app emails it to Wes within seconds: the customer's name, company, phone and email, how they want to be contacted, what they need, the site address, their timeline, and their photos or plans as attachments. The email has buttons to call, text or email the customer and a link to the request in the app, and replying to it answers the customer.

## How it works in the app

- **Who gets it:** Settings > Website quote requests > **Email each new request to**. It starts as the business email (wes@stellarglassllc.com). Up to 5 addresses, separated by commas; leave it blank to stop the emails. Only the owner can change it.
- **Did it go out:** each request in the app says "Emailed to …" or why it wasn't, and Settings shows how the latest one went.
- **Photos and plans:** the email waits up to 2 minutes for the customer's files to finish uploading, then attaches photos and PDFs up to 10 MB in all. Anything left over is on the request in the app.
- **Spam guard:** after 20 requests in one hour, the emails stop until it slows down. Every request is still saved under Requests.
- **Retries:** if the mail server doesn't answer, it tries again for two hours.

## What it costs

Nothing at Wes's volume. Gmail sends up to 500 emails a day from a free account (2,000 from Google Workspace). On Firebase each request, and each parts request sent from the app, is one function run, inside the free 2 million a month, and the app password is one stored secret (6 are free each month). Cloud Functions need the Blaze plan, which the project already has. The only possible charge is a few cents a month for storing the function's code, and the cleanup policy in step 4 keeps that near zero.

## Setup (once)

1. **App password.** Pick the Google account the emails come from. Your own Gmail works; a new free Gmail just for the app keeps copies of the alerts out of your Sent folder. Turn on 2-Step Verification for that account (<https://myaccount.google.com/signinoptions/twosv>), then open <https://myaccount.google.com/apppasswords>, name it `Stellar Glass app` and create it. Google shows 16 letters: that's the app password. Don't paste it into chat, email or a document.
2. **Store it.** In Terminal on the Mac, run this and paste the app password at the hidden prompt:

   ```bash
   firebase functions:secrets:set EMAIL_PASSWORD --project stellar-glass-jobs
   ```

   Or in the browser: <https://console.cloud.google.com/security/secret-manager?project=stellar-glass-jobs>, turn on the Secret Manager API if it asks, then **Create secret** named `EMAIL_PASSWORD` with the app password as its value.
3. **Deploy** (Claude can do this from the Mac), from an up-to-date copy of the app:

   ```bash
   npm install
   npm test
   npm run deploy             # the web app and rules (the Settings field and the email status)
   npm run deploy:alerts      # the server code that sends the emails
   ```

   The first functions deploy asks for **EMAIL_USER**, the address of the account from step 1, and saves it in `functions-alerts/.env.stellar-glass-jobs`. A deploy that can't ask, like one Claude runs, needs that file first, holding the line `EMAIL_USER=` plus the address. This repo is public, so `.gitignore` keeps that file out of it: keep it in the copy you deploy from, or let the next deploy ask again. If the first deploy stops with an Eventarc or permission error, wait five minutes and run `npm run deploy:alerts` again: Google is still setting up permissions for the new trigger.
4. **Cleanup policy** (after the first functions deploy): `npx firebase functions:artifacts:setpolicy --project stellar-glass-jobs` deletes old copies of the function's code after a day.
5. **Try it.** In the app, check the addresses under Settings > Website quote requests and press Save. Then send a request from `/quote` with a photo. The email arrives within seconds (up to two minutes with big photos), and the request in the app says "Emailed to …".

## If something's wrong

The request page and Settings say what happened:

- **"refused the login. It needs a new app password"**: the app password was revoked, which happens when that Google account's password changes. Make a new one (step 1), store it (step 2), then run `npm run deploy:alerts` so the function picks it up.
- **"Couldn't send it yet"**: Gmail didn't answer. It tries again for two hours.
- **"Not emailed: nobody is set to get request emails"**: the Settings field is blank.
- **No note at all on new requests**: the function isn't deployed (step 3).
- The function's log: <https://console.firebase.google.com/project/stellar-glass-jobs/functions/logs>.

## Parts requests to suppliers

Parts orders (in the app's menu under Suppliers & parts) send quote requests, orders and "checking on our order" emails to suppliers. There are four ways to send each one, and only the first needs the server:

- **Send from the app** goes through the same email account as the quote request alerts, so it works once steps 1 to 3 above are done. It goes only to the addresses saved for that supplier under Suppliers (which only the owner or an admin can change), with a copy to the person sending it (unless they untick Copy me) and to the business email if they tick Copy the office. The job files picked on the request go with it (up to 10 files, 15 MB in all). Each business sends up to 40 supplier emails a day this way; after that the app says to use Gmail.
- **Open in Gmail**, **Open in email app** and **Copy email** fill in a new email from the person's own account, with no setup. Files are attached there by hand. The app then asks whether it went out and notes it on the order.

**Who it's from.** An email sent from the app shows the person's name with the business ("Wes Stel at Stellar Glass") but the address of the account the alerts use (`EMAIL_USER`). Replies go to the person who sent it, and they're copied. Suppliers see that address, so it reads best when it's a Stellar Glass mailbox: to change it, make an app password for that account (steps 1 and 2), put its address in `functions-alerts/.env.stellar-glass-jobs` as `EMAIL_USER=`, and run `npm run deploy:alerts`.

**If it doesn't go:** the order says why under Email the supplier ("refused the login" means a new app password, as above), and Open in Gmail always works.

## For developers

- Server code: `functions-alerts/request-alert.js` (who to email, the email itself, waiting for files, retries) and `functions-alerts/index.js` (`requestAlert`, a Firestore trigger on `companies/{companyId}/requests/{requestId}` in us-central1, next to the nam5 database, with retries on and a 5-minute timeout). Node 22 and firebase-functions 6, the same as the Stripe branch.
- It's its own Firebase codebase, `alerts` in `firebase.json`, apart from the Stripe functions in `functions/` (codebase `default`). So deploying the emails needs none of Stripe's keys, and deploying either one never removes the other's functions. `npm run deploy:alerts` names the function in full (`--only functions:alerts:requestAlert`) on purpose: a bare `functions:alerts` also means "a function called alerts in the default codebase", which makes the CLI load the Stripe code and ask for its keys.
- Data: the company's `requestAlertEmails` (array of addresses; until it's saved the email goes to the company's `email`; the existing rules let only the owner change the company). The server writes `alert` on each request: `{ status: 'sending' | 'sent' | 'failed' | 'off' | 'held', at, tries, to, attached, error }`. The rules keep the team's request edits to status, notes, customerId and jobId, so only the server writes `alert`. It claims a request in a transaction before sending, so a repeated event doesn't send a second email.
- Mail goes out with nodemailer through `smtp.gmail.com:465`, logging in as `EMAIL_USER` with `EMAIL_PASSWORD`. `SMTP_HOST` and `SMTP_PORT` in `functions-alerts/.env.stellar-glass-jobs` switch to another provider with a free SMTP relay. Secret values are fixed when the function deploys, so redeploy after changing one.
- Parts requests: `sendPartsEmail` in `functions-alerts/index.js`, a callable function (the app calls it with the request's id; `public/js/firebase.js` `callFunction`), with the work in `functions-alerts/parts-request.js`. It checks the caller is an owner, admin or staff member of that business, builds the email from the request as saved with `parts-email.js` (the same code the app uses for its preview), and sends it to the supplier's saved addresses only. A `sendId` from each press makes a repeated call send nothing more, a transaction claims the send, and `emailUsage/{companyId}` (which only the server can read or write) counts the day's emails, starting over at midnight in Florida. It writes `appEmail` on the request (`{ status: 'sending' | 'sent' | 'failed', sendId, what, at, by, to, cc, attached, error }`), which the rules keep clients from writing, plus a line in the request's history.
- `functions-alerts/parts-email.js` is a copy of `public/js/parts-email.js`, because a function deploys only its own folder. After changing the app's copy run `npm run sync:email`; `npm test` fails while the two differ.
- `npm run deploy:alerts` deploys both functions. The app's side (Parts orders, Suppliers and their rules) goes out with `npm run deploy`. Deploy the rules before or with the app: without them, the suppliers and parts orders collections fall under the general business-records rule.
- Local: run `npm run dev:mail` (a fake mail server that saves each email as a `.eml` file in `functions-alerts/test/mail/`) and `npm run dev:functions`. `functions-alerts/.env.demo-stellar-glass` points the emulator at the fake server.
- `npm test` covers the email's content and escaping, recipients, attachments, waiting for uploads, retries, repeated events and the spam guard (against the Firestore and Storage emulators), plus a real SMTP conversation with the fake server.
- For parts requests it covers reading pasted lists (including Wes's Trulite list), the emails, who can send and to whom, attachments, repeated presses, the daily limit and failures, and the rules for suppliers and parts orders.
- The Stripe branch (PR #2) has its own folder, so the two never edit the same code. When they meet, only shared files conflict: in `firebase.json` keep both entries of the `functions` list; in `package.json` make `postinstall` install both folders, make `test` run `mocha test functions/test functions-alerts/test`, and change Stripe's `deploy:functions` to `firebase deploy --only functions:default`, because a bare `--only functions` deploys both codebases and would ask for the email password too. `.gitignore` and the README keep both sides.
