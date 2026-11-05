# RoleTrack

**Track job applications and review experience requirements without leaving the job listing.** RoleTrack is a Chrome extension that combines a job tracker with an inline experience highlighter in one side panel.

## ✨ Features

- Extracts job details from LinkedIn and Jobstreet listings.
- Highlights experience requirements and summarizes detected years and mentions.
- Saves reviewed applications to a Google Sheet through your own Google Apps Script backend.
- Checks for likely duplicates before adding an application.
- Includes a Jobstreet Quick Apply helper that guides application steps and pauses for unanswered questions.
- Keeps a separate temporary draft for each tab and job while the side panel is open.
- Supports manual entry on other sites and pages the extension cannot access.

## 📦 Install

RoleTrack currently loads as an unpacked extension; there is no build step.

1. Use Chrome 116 or later, or another Chromium browser that supports the Side Panel API.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked** and select this repository's folder (the folder containing `manifest.json`).
4. Refresh any job listing tabs that were already open, then click the RoleTrack toolbar icon.

### Local JobStreet worker (Windows)

The optional local worker opens a dedicated visible Chromium profile using Playwright. It does not use your everyday browser profile. Version 1 supports Singapore JobStreet links and syncs each job using RoleTrack's default application status (`DEFAULT_STATUS` in `utils/status.js`, currently **Applied**). Auto start is forced off. The worker uses the **Dry run** setting saved in this dedicated profile: when on, it stops at Review; when off, it clicks Submit after the configured countdown. It writes to the Sheet configured in RoleTrack, so use a test Sheet while setting it up.

1. Install Node.js 20 or newer.
2. From this folder, run `npm install`, then `npx playwright install chromium`.
3. Run `npm run worker:setup`. In the opened browser, sign in to JobStreet if needed, open the RoleTrack side panel, configure and test your Sheet, and set **Settings → Dry run** as desired. Turn it off only when you intend to submit real applications. Then enter the directory containing your `COVERLETTER_*` files when prompted. The directory is saved locally under `.roletrack-worker/config.json`; setup lets you change it later. The browser profile and extension settings are stored under `.roletrack-worker/profile`.
4. Start one job with `npm run worker:run -- --url "https://sg.jobstreet.com/job/<job-id>"`. If the job is already in the Sheet, choose `continue` to skip the Sheet sync and proceed to Quick Apply, or `end` to stop without opening the application. The worker never creates a duplicate row.
5. For each screening question, the terminal shows the full question, control type, required state, current answer, and complete choices. Enter an option number or a text answer. For a Cover Letter prompt, choose the number beside the desired `COVERLETTER_*` file or type `skip`.
6. Type `pause` in the terminal to stop automation and take over the same browser. Complete the CAPTCHA, login, or other browser step, then type `resume`. Page changes do not resume the worker on their own. Type `cancel` at a question prompt to cancel the task.
7. With Dry run on, the worker waits at Review with the browser open. With Dry run off, it submits after the configured countdown, then waits so you can check JobStreet's confirmation. Type `exit` when you want to close the browser. The run log and failure screenshot are stored under `.roletrack-worker/runs` and are excluded from Git.

If the worker process is interrupted, it does not automatically replay the unfinished task. Run `npm run worker:resume` to reopen the saved application and continue without syncing again. Use `npm run worker:reset` only after inspecting the task and deciding to abandon it; it marks the task cancelled and allows a new run.

The terminal is the first version of the worker's human interaction channel. It does not use n8n, generate Cover Letters, or use stealth behavior. CAPTCHA detection is best-effort; `pause` remains available at any point.

#### Telegram control (optional)

During `npm run worker:setup`, provide a Telegram Bot Token from BotFather, open a private chat with the bot, and send the one-time `bind <code>` shown in the terminal. The token, bound Telegram account, and polling offset are saved only in the Git-ignored `.roletrack-worker/config.json`. Start the same visible worker browser with `npm run worker:telegram`, then send `/apply <JobStreet URL>`. Use `/status`, `/pause`, `/resume`, and `/cancel` to control it. Questions and Cover Letter choices are sent to that private chat; browser verification still happens on the worker computer. Telegram uses Bot API long polling and needs no public webhook. The terminal `worker:run` / `worker:resume` commands remain available.

To position the panel on the right, use **Chrome Settings → Appearance → Side panel → Right**. The browser controls the panel position. See [Chrome's side panel help](https://support.google.com/chrome/answer/13156494).

If you previously used the standalone tracker or highlighter, disable those extensions to avoid overlapping controls. Settings from the old tracker are not imported; enter your Apps Script URL and API key again in RoleTrack.

## 🔗 Connect Google Sheets

RoleTrack sends data to a Google Apps Script web app that you deploy and control.

1. Follow the setup steps in [`gas/README.md`](gas/README.md) to prepare the spreadsheet and deploy the script.
2. In RoleTrack, open **Settings**.
3. Paste the deployed Web App URL (ending in `/exec`) and the script's API key.
4. Choose **Test connection**, then **Save**.

The extension stores these settings locally in the browser. Existing rows and duplicate detection continue to use the same backend and sheet schema.

## 🧭 Use RoleTrack

1. Open a LinkedIn or Jobstreet job listing and click the RoleTrack icon.
2. Review the extracted company, role, salary, location, employment type, URL, and job description. Fill in anything missing.
3. Choose an application status and date, add notes if useful. **Sync + Quick Apply** is the primary action at the top; after a successful sync, RoleTrack opens the Jobstreet Quick Apply flow. Choose the green **Sync only** action below it to save without opening Quick Apply.
4. If RoleTrack finds a duplicate, choose **Cancel** to stop or **Add anyway** to save the duplicate and then continue to Quick Apply.
5. The helper pauses for new questions and requests confirmation for prefilled dropdown answers. **Settings → Dry run** is on by default, so it stops at Review without submitting. Turn it off to allow submission after the locally saved 0-, 3-, 5-, or 10-second countdown; the controller badge shows the live countdown. **Auto start** is off by default; when enabled, it opens Quick Apply after you stay on a Quick Apply job for three seconds. Start manually with **Sync + Quick Apply** or **Alt+A**; the controller shows status and a Stop button, then offers **Close tab** after Submit is clicked.

Experience highlights appear inline on supported listings. The panel shows the detected experience range and mention count; **Show highlight on page** scrolls to the first match.

Use **Re-scan** if a listing loads late or the site changes jobs without changing its URL. Re-scan preserves fields you edited. Temporary drafts are kept per tab and job while the panel is open, then cleared when the panel closes.

### 🌐 Other websites

The generic extractor may work on other websites when Chrome has granted the extension access to that tab. If details are not detected, enter them manually. Browser-internal pages (such as `chrome://` pages) cannot be read by extensions.

## 🔐 Permissions and data

RoleTrack uses Chrome's `sidePanel`, `tabs`, `activeTab`, `scripting`, and `storage` permissions to open the panel, identify the active page, read supported listings, and save local settings. Persistent page access is limited to LinkedIn job pages and Jobstreet. Google Apps Script hosts are permitted for syncing. The tracker writes to the spreadsheet only when you choose **Sync + Quick Apply** or **Add anyway**. The separately controlled Jobstreet helper can advance Quick Apply steps; its dry-run setting is on by default and prevents the final submission.

## 🛠️ Troubleshooting

| Issue | What to try |
| --- | --- |
| A listing is not extracted | Refresh the tab, open a LinkedIn or Jobstreet job listing, then select **Re-scan**. You can also enter details manually. |
| Chrome says the extension cannot access a page | Some pages do not allow extension access. Use manual entry, or click the extension icon on the desired tab and try **Re-scan**. |
| Sync fails | Check the Web App URL and API key in **Settings**, confirm the Apps Script deployment is available, then use **Test connection**. |
| Highlights are missing or incomplete | Re-scan after the job description loads. Detection depends on numeric year mentions near experience-related wording and can vary with page layout. |

## 👩‍💻 Development

The extension has no build step. To run the automated tests:

```sh
npm install
npx playwright install chromium
npm test
```

The tests run the worker helper in Chromium against representative screening-question pages and check shared job validation and sync behavior. They do not replace checking current JobStreet markup or using your own test Sheet.

### 📁 Project layout

| Path | Purpose |
| --- | --- |
| `manifest.json`, `background.js` | Extension configuration and side panel behavior |
| `sidepanel/` | Tracker form, settings, and experience summary |
| `content/`, `content.js`, `content.css` | Page extraction and inline experience highlights |
| `utils/`, `services/` | Shared utilities and Sheets API client |
| `worker/` | Local Playwright worker, extension bridge, and dedicated profile workflow |
| `gas/` | Google Apps Script backend and setup guide |
| `test/` | Automated tests |
