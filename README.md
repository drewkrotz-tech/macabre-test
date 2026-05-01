# MACABRE — TEST BUILD v0.1

A proof-of-concept for the Macabre app. This build does **one thing**: prove that iOS background geofencing reliably fires notifications when you drive within range of a Sinister Site.

**That's it.** No submissions, no accounts, no Firebase, no badges. Just three hardcoded Virginia Beach locations and the geofencing engine.

---

## What's in here

```
macabre-test/
├── src/
│   ├── App.tsx            # Home + Detail UI
│   ├── locations.ts       # 3 hardcoded Sinister Sites
│   ├── geofencing.ts      # Geofence + notification engine
│   └── main.tsx           # React entry
├── index.html
├── package.json           # @capacitor-community/background-geolocation included
├── capacitor.config.ts    # Bundle ID: com.sinistertrivia.macabretest
├── tsconfig.json
├── vite.config.ts
└── IOS_PLIST_ADDITIONS.txt   # ← READ THIS before building iOS
```

---

## The 3 test locations (Virginia Beach)

1. **The Cavalier Hotel** — 36.8534°N, -75.9760°W
2. **Ferry Plantation House** — 36.8920°N, -76.1100°W
3. **Cape Henry Lighthouse** — 36.9265°N, -76.0070°W

Each has a 0.5-mile (~800m) geofence radius.

---

## SETUP — one-time

### 1. Drop into a fresh StackBlitz / GitHub repo

- Create a new private GitHub repo (e.g., `drewkrotz-tech/macabre-test`).
- Open StackBlitz with that repo.
- Drag all the files in this folder into the StackBlitz file tree.
- **Verify** that `package.json`, `capacitor.config.ts`, `index.html`, and the `src/` folder all landed correctly. (Drag-and-drop sometimes creates `(2)` duplicates — check the tree.)

### 2. Install dependencies

In the StackBlitz terminal:

```bash
npm install
```

### 3. Add iOS platform

```bash
npx cap add ios
```

This creates the `ios/` folder.

### 4. Add the plist permissions

Open `ios/App/App/Info.plist` and paste the XML keys from `IOS_PLIST_ADDITIONS.txt` inside the top-level `<dict>` tag.

**This step is non-optional.** If you skip it, Apple will reject the build *and* the app will crash when it tries to access location.

### 5. Sync and copy

```bash
npx vite build
npx cap copy ios
npx cap sync ios
```

### 6. Build via Codemagic → TestFlight

Same flow you use for Sinister Trivia, just with the new bundle ID `com.sinistertrivia.macabretest`. You'll need to register this bundle ID in your Apple Developer account first.

---

## TESTING PROTOCOL

### First launch — permissions

1. Install via TestFlight on your phone.
2. Open the app. iOS will prompt for **location** — tap "Allow While Using App".
3. The plugin will then prompt to upgrade to "Always" — **you must accept this**, or background geofencing will not work.
4. iOS will prompt for **notifications** — tap "Allow".
5. Verify the status bar shows:
   - GEOFENCING: ACTIVE (green)
   - NOTIFICATIONS: GRANTED (green)
   - LOCATION: a coordinate pair (not "WAITING…")

If any of those are red/missing, see Troubleshooting below.

### Test 1 — Simulated trigger (no driving)

1. Tap one of the "Trigger '[site]'" buttons in the **DEV: SIMULATE LOCATION** section at the bottom.
2. A notification should fire within 1 second.
3. Tap the notification → should open that site's detail view.

**If this fails:** the issue is in the notification code, not geofencing. Check console logs.

### Test 2 — The Cavalier drive-by (the real test)

1. Make sure the app has been open at least once and permissions are granted.
2. Close the app completely (don't kill it from the app switcher — just background it).
3. Drive toward the Cavalier (44 South Atlantic Ave, Virginia Beach).
4. As you cross 0.5 miles out, your phone should buzz with:
   > 🩸 **Sinister Site Located**
   > *The Cavalier Hotel — 0.4 mi away. Adolph Coors fell to his death from a 6th-floor window in 1929. He never left.*
5. Tap → opens the detail view.

### What to record during the test

- ✅ / ❌ Did the notification fire?
- How far were you from the site when it fired? (Check the notification text — it includes the distance.)
- Was the app open, backgrounded, or fully quit?
- How long had the app been installed before the test? (Geofences need 1–2 minutes after install to register.)
- Did the notification fire on a *second* approach after walking far away? (Tests the re-arm logic.)

---

## TROUBLESHOOTING

### "Notification fires when I tap the dev button but not when I drive"

Almost certainly an iOS background permission issue.

1. Settings → Macabre Test → Location → must be **"Always"**, not "While Using"
2. Settings → Macabre Test → Notifications → must be enabled
3. Settings → Macabre Test → Background App Refresh → must be ON
4. Reboot the phone (yes, really — iOS sometimes needs this to apply new background permissions)

### "Notification fires late / inconsistently"

Normal for iOS region monitoring. The OS has a "wakeup tolerance" of ~100m around your geofence, and may delay firing by 30–90 seconds depending on cell tower density. This is the OS, not the code.

### "GEOFENCING: OFFLINE in the status bar"

Plugin failed to start. Check Xcode console (or Safari Web Inspector if testing via web preview) for the actual error. Most common causes:
- Missing plist strings (see step 4 above)
- User denied location permission
- Plugin not synced — run `npx cap sync ios` again

### "I'm at the location and nothing fires"

iOS won't trigger a geofence you're *already inside* when monitoring starts. You have to enter from outside. If you launched the app while standing inside the Cavalier, walk a block away and come back.

### Console logging

Connect your iPhone to a Mac with Safari → Develop menu → [your phone] → Macabre Test. You'll see all the `[MACABRE]` log statements in real time. Useful for diagnosing what's actually happening.

---

## WHAT THIS PROVES IF IT WORKS

If notifications fire reliably on the Cavalier drive-by — even when the app is fully backgrounded — then:

1. Capacitor + `@capacitor-community/background-geolocation` is sufficient for production
2. The notification + tap-to-detail-view flow works end-to-end
3. We can confidently commit to the full Macabre v1 build

## WHAT THIS PROVES IF IT FAILS

If notifications don't fire reliably, we need to explore:
1. A native iOS Swift module for region monitoring (most reliable, most work)
2. A different Capacitor community plugin
3. A hybrid approach — Capacitor UI + native iOS background service

We won't know which path until we try this one.

---

## NEXT STEPS AFTER TESTING

Once geofencing is proven, real Macabre v1 adds:
- Firebase backend for the location database
- Submission form for users (camera-only, on-site GPS verification)
- Admin moderation queue
- Contributor profiles with attribution
- Map view of all sites
- "On-Site Verified" badge for in-person submissions

But none of that matters until we know geofencing works.

---

🩸 **Drive to the Cavalier. See if it pings.**
