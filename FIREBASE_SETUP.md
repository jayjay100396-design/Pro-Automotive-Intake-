# Stellar Glass: Firebase setup

The job tracker gets its own Firebase project, separate from the Pro Automotive projects. Everything here stays on Firebase's free Spark plan.

## 1. Create the project (Firebase console, about 5 minutes)

1. Go to <https://console.firebase.google.com> signed in as the account that owns your other Firebase projects, and click **Add project**.
2. Name it **Stellar Glass**. Firebase suggests an ID; set it to `stellar-glass-jobs` (or whatever is free, then put that ID in `.firebaserc`).
3. Turn Google Analytics **off** (not needed).
4. Stay on the **Spark (free)** plan. Don't add billing.

## 2. Turn on the services

- **Build > Authentication > Get started > Email/Password: Enable.** Leave "Email link" off for now. Under **Settings > Authorized domains**, keep only `localhost` and the project's own `*.web.app` / `*.firebaseapp.com` domains.
- **Build > Firestore Database > Create database**, location `nam5 (United States)`, start in **production mode** (everything denied until the rules below are deployed).
- **Hosting** is set up by the deploy in step 4; nothing to click.
- **Storage** (job photos and plans) now needs the Blaze plan on new projects, which means adding a card even though small use stays at $0. Skip it until Wes needs uploads; `storage.rules` is ready for then.

## 3. Register the web app and lock down the API key

1. **Project settings > General > Your apps > Web (`</>`)**, nickname `stellar-glass-web`. Copy the `firebaseConfig` it shows; the app's code will use it. That config is meant to be public; the security rules are what protect the data.
2. In <https://console.cloud.google.com/apis/credentials> (select the Stellar Glass project), open the **Browser key (auto created by Firebase)**:
   - **Application restrictions: Websites**, add `https://stellar-glass-jobs.web.app/*`, `https://stellar-glass-jobs.firebaseapp.com/*` and `http://localhost/*`.
   - **API restrictions: Restrict key**, keep only Identity Toolkit API, Token Service API, Cloud Firestore API, Firebase Installations API and (later) Cloud Storage for Firebase API.
3. Optional, later: **App Check** with reCAPTCHA Enterprise to block scripted abuse.

## 4. Deploy the rules (from this repo)

```bash
npm install
npx firebase login          # same Google account as step 1
npx firebase use stellar-glass-jobs
npm test                     # runs the rules tests on the local emulator (needs Java)
npm run deploy:rules         # Firestore rules + indexes (drop ",storage" until Storage is on)
npx firebase deploy --only hosting
```

## How the security rules work

- Every record lives under a company: `companies/{companyId}/jobs/...`, `/estimates`, `/contracts`, `/changeOrders`, `/payApps`, `/invoices`, `/customers`.
- A person can see a company's data only if they have a member record at `companies/{companyId}/members/{theirUserId}`. Other companies' data is invisible to them, and signed-out visitors see nothing.
- Roles: **owner** (Wes) can do everything; **admin** manages records and staff; **staff** (crew) create and edit records but can't delete; **accountant** is read-only.
- A new sign-up can create one company with themselves as owner. Nobody can add themselves to someone else's company, make a second owner, change their own role, or remove the owner.
- `users/{uid}` profiles are private to each user. Everything else is denied.

`test/firestore.rules.test.js` checks each of those cases against the Firestore emulator.
