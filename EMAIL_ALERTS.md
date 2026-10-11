# Stellar Glass: quote request emails

When a customer sends a request from the quote page (`/quote`), the app emails it to Wes within seconds: the customer's name, company, phone and email, how they want to be contacted, what they need, the site address, their timeline, and their photos or plans as attachments. The email has buttons to call, text or email the customer and a link to the request in the app, and replying to it answers the customer.

## How it works in the app

- **Who gets it:** Settings > Website quote requests > **Email each new request to**. It starts as the business email (wes@stellarglassllc.com). Up to 5 addresses, separated by commas; leave it blank to stop the emails. Only the owner can change it.
- **Did it go out:** each request in the app says "Emailed to …" or why it wasn't, and Settings shows how the latest one went.
- **Photos and plans:** the email waits up to 2 minutes for the customer's files to finish uploading, then attaches photos and PDFs up to 10 MB in all. Anything left over is on the request in the app.
- **Spam guard:** after 20 requests in one hour, the emails stop until it slows down. Every request is still saved under Requests.
- **Retries:** if the mail server doesn't answer, it tries again for two hours.

## What it costs

Nothing at Wes's volume. Gmail sends up to 500 emails a day from a free account (2,000 from Google Workspace). On Firebase each request is one function run, inside the free 2 million a month, and the app password is one stored secret (6 are free each month). Cloud Functions need the Blaze plan, which the project already has. The only possible charge is a few cents a month for storing the function's code, and the cleanup policy in step 4 keeps that near zero.

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
   npm run deploy:functions   # the server code that sends the emails
   ```

   The first functions deploy asks for **EMAIL_USER**, the address of the account from step 1, and saves it in `functions/.env.stellar-glass-jobs`. A deploy that can't ask, like one Claude runs, needs that file first, holding the line `EMAIL_USER=` plus the address. It isn't a secret, so it can be committed. If the first deploy stops with an Eventarc or permission error, wait five minutes and run `npm run deploy:functions` again: Google is still setting up permissions for the new trigger.
4. **Cleanup policy** (after the first functions deploy): `npx firebase functions:artifacts:setpolicy --project stellar-glass-jobs` deletes old copies of the function's code after a day.
5. **Try it.** In the app, check the addresses under Settings > Website quote requests and press Save. Then send a request from `/quote` with a photo. The email arrives within seconds (up to two minutes with big photos), and the request in the app says "Emailed to …".

## If something's wrong

The request page and Settings say what happened:

- **"refused the login. It needs a new app password"**: the app password was revoked, which happens when that Google account's password changes. Make a new one (step 1), store it (step 2), then run `npm run deploy:functions` so the function picks it up.
- **"Couldn't send it yet"**: Gmail didn't answer. It tries again for two hours.
- **"Not emailed: nobody is set to get request emails"**: the Settings field is blank.
- **No note at all on new requests**: the function isn't deployed (step 3).
- The function's log: <https://console.firebase.google.com/project/stellar-glass-jobs/functions/logs>.

## For developers

- Server code: `functions/request-alert.js` (who to email, the email itself, waiting for files, retries) and `functions/index.js` (`requestAlert`, a Firestore trigger on `companies/{companyId}/requests/{requestId}` in us-central1, next to the nam5 database, with retries on and a 5-minute timeout). Node 22 and firebase-functions 6, the same as the Stripe branch.
- Data: the company's `requestAlertEmails` (array of addresses; until it's saved the email goes to the company's `email`; the existing rules let only the owner change the company). The server writes `alert` on each request: `{ status: 'sending' | 'sent' | 'failed' | 'off' | 'held', at, tries, to, attached, error }`. The rules keep the team's request edits to status, notes, customerId and jobId, so only the server writes `alert`. It claims a request in a transaction before sending, so a repeated event doesn't send a second email.
- Mail goes out with nodemailer through `smtp.gmail.com:465`, logging in as `EMAIL_USER` with `EMAIL_PASSWORD`. `SMTP_HOST` and `SMTP_PORT` in `functions/.env.stellar-glass-jobs` switch to another provider with a free SMTP relay. Secret values are fixed when the function deploys, so redeploy after changing one.
- Local: run `npm run dev:mail` (a fake mail server that saves each email as a `.eml` file in `functions/test/mail/`) and `npm run dev:functions`. `functions/.env.demo-stellar-glass` points the emulator at the fake server.
- `npm test` covers the email's content and escaping, recipients, attachments, waiting for uploads, retries, repeated events and the spam guard (against the Firestore and Storage emulators), plus a real SMTP conversation with the fake server.
- The Stripe branch (PR #2) also adds `functions/`. When the two meet, keep both sets of exports in `functions/index.js`, both dependency lists in `functions/package.json` (then run `npm install` in `functions/` to rebuild the lockfile), and both blocks in `functions/.env.demo-stellar-glass`, `.gitignore`, `package.json` scripts and the README.
