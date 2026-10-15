# Stellar Glass: schedule and Google Calendar

The app has a **Schedule** for site measures, installs, meetings, deliveries, tasks and time off, with who's on each one and reminders. The schedule can be copied to Google Calendar, so it shows on everyone's phone with Google's reminders, even for people who never open the app.

## How it works in the app

- **Schedule** (in the menu, under Dashboard): an agenda of the next four weeks, a month view, and a team week with one row per person. Filter by person or by kind of event. Overdue tasks are listed first.
- **Kinds of events:** site measure, install, meeting, delivery, task, time off and other. Each has a color, its usual length and its usual reminders, which can be changed per event. An event can be all day or span several days, and can repeat every week, month or year, with an end date if it has one.
- **Tasks** have a due date and a Done box. A repeating task, like "send the pay app on the 25th", moves on to its next date when it's ticked off.
- **Who's on it:** tick the team members on an event. Everyone on it gets it on their own Google Calendar, once they've connected theirs.
- **Jobs and customers:** pick the job and the customer and the site address is filled in. The job's page lists its schedule, with a button to add to it. The dashboard shows what's on today and what's coming up, and the menu shows today's count, or the overdue tasks.
- **Roles:** the owner, admins and staff schedule anything. The accountant adds tasks and meetings of their own and ticks off tasks they're on. Owners and admins delete any event, staff the ones they added, and the accountant none.

### Google Calendar

It's one way: **the app is the master copy, and changes go from the app to Google**. Nothing is read back from Google, so personal events in those calendars never come into the app, and connecting, switching or disconnecting a calendar never changes or deletes anything in the app. In Google, the app only ever changes or removes the events it put there (each carries a hidden tag), never anyone's own events. Changes made to those events in Google don't come back to the app, and are replaced when the event next changes in the app, so make changes in the app.

There are two kinds of connections, both in **Settings > Google Calendar**:

- **Business calendar** (the owner): every event goes on one calendar in the owner's Google account. By default the app makes a new calendar called "Stellar Glass" for it, which keeps the schedule apart from personal events and can be shown or hidden with one click in Google Calendar. **Use a different calendar** lets the owner pick one of their own calendars instead. Switching copies the app's events to the new calendar first and takes them off the old one only once that worked, so if Google won't let the app add events to the calendar picked, everything stays where it was.
- **Your own calendar** (anyone on the team): the events you're on go on a "Stellar Glass – my schedule" calendar in your own Google account, with their reminders. This is how reminders reach the right person's phone. Connect it in Settings, or from the offer at the top of the Schedule page.

Owners and admins see who on the team has connected, and can disconnect someone (for example, after they leave the team). As with removing someone from the team, an admin can disconnect staff and the accountant, and only the owner can disconnect an admin.

### Handing the business to Wes

1. Jason transfers ownership (Settings > Transfer ownership). From then on, nothing new goes to Jason's business calendar: it's paused, and Settings says so.
2. Wes opens **Settings > Google Calendar** and clicks **Connect my Google Calendar** with his own Google account. The app makes a "Stellar Glass" calendar in Wes's account and copies the whole schedule to it. Wes can pick one of his own calendars instead with **Use a different calendar**.
3. At the same moment the app removes its own events from Jason's calendar, and deletes the "Stellar Glass" calendar it made there if nothing else is in it. Jason's own events are never touched, and nothing in the app changes: every customer, job and event stays.

Until Wes connects, Jason can also take the app's events off his calendar himself with **Remove the app's events from my calendar** in Settings.

## What it costs

Nothing at Stellar Glass's size. The Google Calendar API is free. The copying runs as two Cloud Functions, well inside the free 2 million runs a month, and it uses no stored secrets and no scheduled jobs. Cloud Functions need the Blaze plan, which the project already has. The only possible charge is a few cents a month for storing the functions' code, and the cleanup policy in step 5 keeps that near zero.

## Setup (once)

1. **Turn on the Google Calendar API:** <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=stellar-glass-jobs>, click **Enable**.

2. **Let the app open Google's permission window.** Open <https://console.cloud.google.com/apis/credentials?project=stellar-glass-jobs> and click **Web client (auto created by Google Service)** under OAuth 2.0 Client IDs. Under **Authorized JavaScript origins**, make sure these are listed, adding any that are missing:
   - `https://stellar-glass-jobs.web.app`
   - `https://stellar-glass-jobs.firebaseapp.com`

   Click **Save**. Don't change anything else there: it's the same client that Google sign-in uses. Google can take a few minutes to apply it; until then the permission window says "origin mismatch".

3. **Check that the Google sign-in screen is published.** Open <https://console.cloud.google.com/auth/audience?project=stellar-glass-jobs>. **Publishing status** should say **In production**. If it says **Testing**, click **Publish app**: in testing, only listed test users can connect, and Google cuts their access after 7 days. **Branding** (in the left menu) can set the app name to "Stellar Glass", but Google shows that name only after it has verified the app. Until then its windows name the web address instead (step 6), which is fine for a business this size.

4. **Let the calendar functions read the app's Google sign-in settings.** The functions use the same Google client as the app's Google sign-in. Instead of a copied secret, they read its settings from Firebase when someone connects, which needs one role. First turn on the Compute Engine API at <https://console.cloud.google.com/apis/library/compute.googleapis.com?project=stellar-glass-jobs> (click **Enable**): the account below only exists once it's on, and the role can't be saved without it. Then open <https://console.cloud.google.com/iam-admin/iam?project=stellar-glass-jobs>, find **983625532359-compute@developer.gserviceaccount.com** (Default compute service account), click its pencil, **Add another role**, choose **Firebase Authentication Admin**, and **Save**. Or paste this in Cloud Shell (<https://shell.cloud.google.com/?project=stellar-glass-jobs&show=terminal>):

   ```bash
   gcloud projects add-iam-policy-binding stellar-glass-jobs --member=serviceAccount:983625532359-compute@developer.gserviceaccount.com --role=roles/firebaseauth.admin
   ```

   Without it, Settings > Google Calendar says "Calendar sync can't read the app's Google sign-in settings."

5. **Deploy** (Claude can do this from the Mac), from an up-to-date copy of the app:

   ```bash
   npm install
   npm test
   npm run deploy             # the web app and the rules (the Schedule page)
   npm run deploy:calendar    # the server code that copies the schedule to Google Calendar
   npx firebase functions:artifacts:setpolicy --project stellar-glass-jobs   # once: delete old copies of the code after a day
   ```

   If the first functions deploy stops with an Eventarc or permission error, wait five minutes and run `npm run deploy:calendar` again: Google is still setting up permissions for the new trigger. The Schedule page works without the functions; until they're deployed, Settings says Google Calendar isn't set up yet.

   Without a person at the keyboard (Claude on the Mac), the deploy stops at a question about the trigger's retries, and the cleanup policy at a yes/no. Use these instead, which deploy only the two calendar functions:

   ```bash
   npx firebase deploy --only functions:calendar:calendarAccount,functions:calendar:calendarSync --project stellar-glass-jobs --non-interactive --force
   npx firebase functions:artifacts:setpolicy --project stellar-glass-jobs --force
   ```

   Never add `--force` to `npm run deploy:calendar` or `npm run deploy`: they also deploy the Firestore indexes, and with `--force` that deletes any live index that isn't in `firestore.indexes.json`.

6. **Connect the business calendar.** The owner opens **Settings > Google Calendar**, clicks **Connect Google Calendar**, picks the Google account, and allows calendar access (tick the Google Calendar box if Google shows one). If Google says **"Google hasn't verified this app"**, click **Advanced**, then **Go to stellar-glass-jobs.firebaseapp.com** (or **stellar-glass-jobs.web.app**): it's your own app, and Google allows up to 100 people to use an unverified one. The app makes the "Stellar Glass" calendar and copies the schedule; it shows up in Google Calendar on the phone within a minute.

7. **Everyone else** connects their own calendar from Settings or the Schedule page, the same way.

## If something's wrong

Settings > Google Calendar shows each connection's state:

- **"Google Calendar access was removed. Connect again."**: the person removed the app's access in their Google account (or changed their password). Press **Connect again**.
- **"The chosen calendar was deleted in Google. Choose another."**: press **Use a different calendar**. If the deleted calendar was the one the app made, the app makes a new one on its own.
- **"Some events aren't on Google Calendar yet"** or **"Google Calendar didn't answer"**: press **Sync now**. Changes also retry on their own.
- **"Paused: the business has a new owner"**: the new owner connects their own calendar (above).
- **"Google Calendar access wasn't allowed"** after Connect: Google's window has a box for calendar access that can be left unticked. Press **Connect** again and tick it.
- **"Google didn't let the app add events to that calendar"** after **Use a different calendar**: the schedule stays on the calendar it was on. Pick a calendar you made yourself (not one shared with you or a subscribed one), or **A new calendar just for the app**.
- **"Calendar sync can't read the app's Google sign-in settings"**: step 4.
- **"origin mismatch" in Google's window**: step 2.
- **Connect or Sync now does nothing, and the browser's console shows a CORS error**: the `calendarAccount` function has to let anyone call it (it checks who's signed in itself). Firebase sets that only when it first creates the function, so if that first deploy failed partway it can be missing. In <https://console.cloud.google.com/run?project=stellar-glass-jobs>, open **calendaraccount**, then **Security**, and choose **Allow unauthenticated invocations** (or give `allUsers` the **Cloud Run Invoker** role).
- The functions' log: <https://console.firebase.google.com/project/stellar-glass-jobs/functions/logs>.

## For developers

- **App:** `public/js/schedule.js` (the Schedule page, the event form, and the cards on the dashboard and job pages), `public/js/when.js` (dates, repeats and reminders; unit tested in `test/when.test.mjs`) and `public/js/gcal.js` (the Google Calendar panel). `data.js` keeps events from three months ago on loaded, plus every open task and every repeating event; the Schedule page loads older ones when someone pages back to them.
- **Data:** `companies/{companyId}/events/{eventId}` holds the events (fields and checks in `firestore.rules`). Dates are wall-clock text in the business's time zone: `YYYY-MM-DD` for all-day events, whose `end` is the last day, and `YYYY-MM-DDTHH:MM` otherwise, so daylight saving time never moves an appointment. `calendarLinks/{business | uid}` is each connection's state for the app to show, and `calendarTokens/{business | uid}` its Google access (a refresh token). The rules let only the server write either one, and nobody but the server read the tokens.
- **Other screens can add events:** `scheduleLink({ type, jobId, title, date, time, ref, refLabel, ... })` from `schedule.js` gives a link to a filled-in event form, and `addEvent({ ... })` adds one directly. `ref` (`{ path: '#/…', label }`) links the event back to the record that made it, such as a parts order.
- **Server:** `functions-calendar/` is its own Firebase codebase, `calendar`, apart from the Stripe functions (`functions/`, codebase `default`) and the request emails (`functions-alerts/`, codebase `alerts`). `calendarAccount` (callable) connects, lists and chooses calendars, syncs and disconnects. `calendarSync` (Firestore trigger on events, with retries) copies each change to every connected calendar that should have it. `npm run deploy:calendar` names both functions in full, so it never loads the other codebases or asks for their secrets. It also deploys the Firestore indexes, since the functions need the `calendarTokens.emailKey` one.
- **Google access:** the browser gets a one-time code from Google Identity Services, and the server trades it for a refresh token. The scope is `calendar.app.created`, which only lets the app see and change calendars it made. Using one of the owner's own calendars adds `calendar.calendarlist.readonly` and `calendar.events.owned`, asked for only when the owner chooses to.
- **Safety:** each Google event's id comes from the app event's id, so a retry can never make a duplicate. Every Google event the app makes also carries the private properties `stellar=1` and `stellarCompany` (the business's id). The server only changes or deletes events with its own ids, and its cleanups only list events that carry both tags (checked again in code, since Google's documentation doesn't agree on whether two tag filters must both match), so two businesses that use one calendar never touch each other's events. A calendar is deleted only if the app made it and it's empty. Google access is revoked on disconnect only when no other connection uses the same Google account, in this business or another one (Google gives a person one grant for the app, so a revoke ends it everywhere). The server finds those connections by `emailKey`, with the index in `firestore.indexes.json`. Google sends a refresh token only the first time a person agrees, so one that a failed Connect didn't save is revoked (when nothing else uses that account), and the next Connect gets a new one.
- **Local:** run `npm run dev:google` (a fake Google that keeps calendars in memory, on port 8790) and `npm run dev:calendar` (the emulators, with functions). `functions-calendar/.env.demo-stellar-glass` points the functions emulator at the fake Google. On localhost, Connect asks which account to pretend to connect instead of opening Google's window.
- **Tests:** `npm test` runs the rules tests (including `test/schedule.rules.test.js`), the date tests, and the functions' tests against the fake Google and the Firestore emulator.
- **Merging with the other open branches** (Stripe PR #2, request emails PR #5, parts orders PR #6, takeoffs PR #7): only shared files conflict, and each conflict keeps both sides. In `firebase.json`, keep every entry of the `functions` list. In `package.json`, make `postinstall` install every functions folder, make `test` run every test folder (`mocha test functions/test functions-alerts/test functions-calendar/test`), and keep each `deploy:` script. In `firestore.indexes.json`, keep every index and field override. In `app.css`, `firestore.rules`, the menu in `app.js`, `.gitignore` and the README, keep both blocks.
