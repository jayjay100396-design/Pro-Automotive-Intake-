# Stellar Glass: Firebase setup

The job tracker gets its own Firebase project, separate from the Pro Automotive projects. Everything except Phone sign-in and Storage fits Firebase's free tier. Phone sign-in (SMS codes) and Storage need the Blaze plan; at Wes's volume they should stay at or near $0, and SMS is billed per text after the free allowance.

## 1. Create the project (Firebase console, about 5 minutes)

1. Go to <https://console.firebase.google.com> signed in as the account that owns your other Firebase projects, and click **Add project**.
2. Name it **Stellar Glass**. Firebase suggests an ID; set it to `stellar-glass-jobs` (or whatever is free, then put that ID in `.firebaserc`).
3. Turn Google Analytics **off** (not needed).
4. Stay on the **Spark (free)** plan. Don't add billing.

## 2. Turn on the services

- **Authentication > Sign-in method** (<https://console.firebase.google.com/project/stellar-glass-jobs/authentication/providers>):
  - **Email/Password: Enable.** Leave "Email link" off.
  - **Google: Enable**, pick a support email, Save.
  - **Phone: Enable.** Texting codes needs the Blaze plan. Then, under **Settings > SMS region policy**, choose **Allow** and select only **United States**, so nobody can run up SMS charges with foreign numbers.
  - **Settings > Authorized domains** (<https://console.firebase.google.com/project/stellar-glass-jobs/authentication/settings>): keep `localhost`, `stellar-glass-jobs.web.app` and `stellar-glass-jobs.firebaseapp.com`. Add any custom domain here later.
- **Build > Firestore Database > Create database**, location `nam5 (United States)`, start in **production mode** (everything denied until the rules below are deployed).
- **Hosting** is set up by the deploy in step 4; nothing to click.
- **Storage** (job files) needs the Blaze plan on new projects. Open <https://console.firebase.google.com/project/stellar-glass-jobs/storage>, click **Get started**, choose production mode and a US location, then **Done**. The deploy in step 4 puts `storage.rules` in place. The first 5 GB stored are free; after that it's about 2.6 cents per GB a month.

## 3. Register the web app and lock down the API key

1. **Project settings > General > Your apps > Web (`</>`)**, nickname `stellar-glass-web`. Copy the `firebaseConfig` it shows; the app's code will use it. That config is meant to be public; the security rules are what protect the data.
2. In <https://console.cloud.google.com/apis/credentials> (select the Stellar Glass project), open the **Browser key (auto created by Firebase)**:
   - **Application restrictions: Websites**, add `https://stellar-glass-jobs.web.app/*`, `https://stellar-glass-jobs.firebaseapp.com/*` and `http://localhost/*`.
   - **API restrictions: Restrict key**, keep only Identity Toolkit API, Token Service API, Cloud Firestore API, Firebase Installations API and Cloud Storage for Firebase API. (Google Drive calls use each person's own Google sign-in, not this key.)
3. Optional, later: **App Check** with reCAPTCHA Enterprise to block scripted abuse.

## 4. Deploy (from this repo, on a computer signed in to Firebase)

```bash
npm install
npx firebase login          # same Google account as step 1
npx firebase use stellar-glass-jobs
npm test                     # money math + rules tests on the local emulator (needs Java)
npm run deploy               # Firestore and Storage rules, indexes and the web app
```

The app is then live at <https://stellar-glass-jobs.web.app>. The first person to sign in creates the business and becomes its owner.

## 5. Job files and Google Drive

Each job has a **Files** tab (and there's a **Files** page across all jobs) for photos, videos, plans, contracts, permits and notarized forms, saved emails, Word, Excel and PDF files. Files are sorted into Photos, Plans & drawings, Contracts & documents, Permits & forms and Other, with a note on each, and can be searched. Photos get a small preview so the list loads fast on a phone. Limits: 25 MB per file, 100 MB per video.

**Save to Google Drive** keeps a copy of a job's files in the signed-in person's own Drive, in `Stellar Glass Jobs / <customer> / <job> / <category>`. Once connected, new uploads are copied automatically, and **Copy N files to Drive** catches up on older ones. It runs in the browser with Google's `drive.file` permission, so the app can only see the folders and files it made, and there's no server or fee. Renaming a job or customer in the app renames its Drive folder on the next copy. Deleting a file in the app leaves the Drive copy alone. Someone who signs in by email or phone and connects Drive also gets that Google account as a sign-in option.

Two one-time steps in Google Cloud for the Drive copies:

1. **Turn on the Google Drive API:** <https://console.cloud.google.com/apis/library/drive.googleapis.com?project=stellar-glass-jobs>, click **Enable**. (Google sign-in must also be on, step 2.)
2. **Let the app read stored files back** (needed to copy files that were uploaded before Drive was connected). Open Cloud Shell at <https://shell.cloud.google.com/?project=stellar-glass-jobs&show=terminal> and paste:

   ```bash
   printf '[{"origin":["https://stellar-glass-jobs.web.app","https://stellar-glass-jobs.firebaseapp.com"],"method":["GET"],"maxAgeSeconds":3600}]' > cors.json && gcloud storage buckets update gs://stellar-glass-jobs.firebasestorage.app --cors-file=cors.json
   ```

   From a computer with the Google Cloud CLI, `npm run storage:cors` does the same with this repo's `cors.json`. If the bucket has a different name, it's shown at the top of the Storage page.

## 5b. Public quote request page

Customers can ask for a quote, with photos or plans, at **https://stellar-glass-jobs.web.app/quote** without signing in. The page follows the look of stellarglassllc.com (home, services, gallery, contact). Link to it from the main website, a Google Business profile or a text to a customer.

- **Turn it on:** after deploying, the owner opens **Settings > Website quote requests** and clicks **Turn on website requests**. Do this right after the deploy: the first owner to turn it on is the business the page sends to, and after that only that owner can change or pause it. Until then the page shows the phone number and email instead of sending.
- **Where requests go:** **Requests** in the menu (with a count of new ones) and a tile on the dashboard. Each request shows the contact details, the project and the photos. **Create customer and job** adds the customer (or picks a matching one by email or phone), a lead job with the site and details, and puts the photos and PDFs in the job's Files, ready for an estimate.
- **Spam:** a hidden field and a short timer catch simple bots, and the security rules only accept the form's own fields, with size limits, at most 8 files of 20 MB (photos or PDFs), uploaded within an hour of sending. Nobody outside the team can read requests or their files.
- **No email alert yet:** check Requests in the app. An email or text alert needs a Cloud Function and an email service.
- **Photos on the page:** the owner or an admin changes them on the **Website** page in the app (under Admin). Replace the top photo and each service photo, and add gallery photos (many at once), with optional captions and an order; visitors can click a gallery photo to see it full size. Big photos are resized to 2400 px on the long side before upload. Until you upload your own, the page shows starter photos in `public/img/site/`, cut from screenshots of the old website, so they're small. The Website page works once website requests are turned on, because that connects the page to your business.

## 6. Try it locally first (optional)

```bash
npm run dev                  # auth + Firestore + Storage + hosting emulators, nothing touches the real project
```

Open <http://127.0.0.1:5000>. On localhost the app uses the emulators automatically (add `?live` to the URL to use the real project). For phone sign-in on the emulator, the code is shown in the emulator log instead of being texted.

## How the security rules work

- Every record lives under a company: `companies/{companyId}/jobs/...`, `/estimates`, `/contracts`, `/changeOrders`, `/payApps`, `/invoices`, `/customers`, `/files`. Uploaded files are in Storage at `companies/{companyId}/{category}/{jobId}/{fileId}/{name}`.
- A person can see a company's data only if they have a member record at `companies/{companyId}/members/{theirUserId}`. Other companies' data is invisible to them, and signed-out visitors see nothing.
- Roles: **owner** (Wes) can do everything; **admin** manages records and staff; **staff** (crew) create and edit records but can't delete; **accountant** reads everything and creates and edits invoices, pay apps (G702/G703), billing, documents and forms, and can upload to the `documents/` and `forms/` storage folders (e.g. notarized papers), but can't delete anything or manage members. The owner or an admin invites people from **Settings > Team**: the app makes a single-use link (expires in 7 days) for a chosen role, and the person opens it, signs in any way they like, and taps Join. Only the owner can invite or make admins.
- Files: owners, admins and staff add files anywhere; the accountant adds them only as Contracts & documents or Permits & forms. Owners and admins can delete any file; staff can delete only files they added; the accountant deletes none. Anyone on the team can copy files to their own Drive.
- A new sign-up can create one company with themselves as owner. Nobody can add themselves to someone else's company, make a second owner, change their own role, or remove the owner. The owner can hand the company to an existing member (Settings > Transfer ownership); that member becomes owner and the old owner becomes admin, all in one step.
- `users/{uid}` profiles are private to each user. Everything else is denied.

`test/firestore.rules.test.js` and `test/storage.rules.test.js` check each of those cases against the Firestore and Storage emulators (`npm test`).
