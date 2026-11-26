# Cash Book (no app store needed)

A phone-friendly web app for a small team to record every cash payment in or out (catering and in-store). Staff unlock it with a PIN, pick a date, amount, In/Out and category, add an optional comment, and the entry lands in your Google Sheet. The landing page shows the running cash balance, this month's totals and the latest entries.

- `index.html`, `manifest.webmanifest`, `sw.js`, `icons/` : the phone screen, hosted free on GitHub Pages.
- `apps-script/Code.gs` : the API that checks PINs and writes to the Sheet (Google Apps Script).

## 1. Google Sheet + API

1. Create a new Google Sheet (keep its sharing restricted to you). Open **Extensions > Apps Script**.
2. Replace `Code.gs` with [apps-script/Code.gs](apps-script/Code.gs).
3. Select `setup` in the toolbar and click **Run** (approve the permissions). This creates the `Users` and `Cash` tabs.
4. In the `Users` tab add one row per person: `Name | PIN | TRUE | TRUE for admins, blank otherwise`.
   PINs are 4 to 8 digits and must be **unique** (the PIN alone identifies the person).
   To remove access, set Active to `FALSE`. To change a PIN, edit the cell.
5. **Deploy > New deployment > Web app**: Execute as **Me**, Who has access **Anyone**. Copy the URL (ends in `/exec`).

## 2. Put the URL in the screen

In [index.html](index.html), replace `PASTE_WEB_APP_URL_HERE` with the `/exec` URL. Also set `CURRENCY` just below it (default `AUD`).

## 3. Publish on GitHub Pages

1. Create a new repository on GitHub (e.g. `cashbook`).
2. From this folder run:
   ```
   git init
   git add .
   git commit -m "Cash Book app"
   git branch -M main
   git remote add origin https://github.com/<your-username>/cashbook.git
   git push -u origin main
   ```
3. On GitHub: **Settings > Pages > Source: Deploy from a branch > main / (root) > Save**.
4. After a minute the app is live at `https://<your-username>.github.io/cashbook/`. Send that link to your team.

Note: a free GitHub account needs the repository to be **public** for Pages. The repo holds no secrets (PINs live in the Sheet), but the Apps Script URL is visible in `index.html`. That is why PINs plus lockout matter. Use PINs of 6+ digits that are hard to guess.

## 4. Install on phones

- **iPhone (Safari only):** Share > Add to Home Screen
- **Android (Chrome):** menu > Install app / Add to Home screen

## How it works

- **Entry:** Date (defaults to today), Cash In / Cash Out toggle, amount, category and a comment. The categories change with the toggle. Edit them in `CATEGORIES` at the top of `Code.gs`, then redeploy.
- **Sheet columns (`Cash` tab):** Entered At, Date, Type, Amount, Category, Comment, Entered By, ID, Status.
- **Balance** = total In minus total Out, ignoring voided rows. It is calculated by the script, so it stays correct if you add older entries by hand in the sheet (fill in an ID so they show up).
- **Removing an entry:** the "Remove" link on a recent entry marks the row `Void` (it is never deleted, so there is an audit trail). The person who entered it or an admin can do this.
- **Lockout:** 5 wrong PINs lock that phone for 10 minutes; 30 wrong PINs across all phones pauses sign-in for 10 minutes.
- Times use the script's time zone (**Project Settings** in Apps Script). Check it is correct.
- After editing `Code.gs`, use **Deploy > Manage deployments > Edit > New version** (the URL stays the same).
- The app needs internet to save. After you change `index.html`, bump the cache name in `sw.js` so phones pick up the new screen.
