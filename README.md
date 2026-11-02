# RoleTrack

**Track job applications and review experience requirements without leaving the job listing.** RoleTrack is a Chrome extension that combines a job tracker with an inline experience highlighter in one side panel.

## ✨ Features

- Extracts job details from LinkedIn and JobStreet listings.
- Highlights experience requirements and summarizes detected years and mentions.
- Saves reviewed applications to a Google Sheet through your own Google Apps Script backend.
- Checks for likely duplicates before adding an application.
- Includes a JobStreet Quick Apply helper that guides application steps and pauses for unanswered questions.
- Keeps a separate temporary draft for each tab and job while the side panel is open.
- Supports manual entry on other sites and pages the extension cannot access.

## 📦 Install

RoleTrack currently loads as an unpacked extension; there is no build step.

1. Use Chrome 116 or later, or another Chromium browser that supports the Side Panel API.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked** and select this repository's folder (the folder containing `manifest.json`).
4. Refresh any job listing tabs that were already open, then click the RoleTrack toolbar icon.

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

1. Open a LinkedIn or JobStreet job listing and click the RoleTrack icon.
2. Review the extracted company, role, salary, location, employment type, URL, and job description. Fill in anything missing.
3. Choose an application status and date, add notes if useful, then select **Sync to Google Sheets**.
4. If RoleTrack finds a possible duplicate, choose **Cancel** or **Add anyway**.
5. On a JobStreet listing, use the helper overlay or press **Alt+A** to open its Quick Apply flow. It pauses for new questions and requests confirmation for prefilled dropdown answers. Its dry-run setting is on by default, so it will stop at Review without submitting. The helper can also be set to auto-start after you stay on a Quick Apply listing for three seconds.

Experience highlights appear inline on supported listings. The panel shows the detected experience range and mention count; **Show highlight on page** scrolls to the first match.

Use **Re-scan** if a listing loads late or the site changes jobs without changing its URL. Re-scan preserves fields you edited. Temporary drafts are kept per tab and job while the panel is open, then cleared when the panel closes.

### 🌐 Other websites

The generic extractor may work on other websites when Chrome has granted the extension access to that tab. If details are not detected, enter them manually. Browser-internal pages (such as `chrome://` pages) cannot be read by extensions.

## 🔐 Permissions and data

RoleTrack uses Chrome's `sidePanel`, `tabs`, `activeTab`, `scripting`, and `storage` permissions to open the panel, identify the active page, read supported listings, and save local settings. Persistent page access is limited to LinkedIn job pages and JobStreet. Google Apps Script hosts are permitted for syncing. The tracker writes to the spreadsheet only when you choose **Sync to Google Sheets** or **Add anyway**. The separately controlled JobStreet helper can advance Quick Apply steps; its dry-run setting is on by default and prevents the final submission.

## 🛠️ Troubleshooting

| Issue | What to try |
| --- | --- |
| A listing is not extracted | Refresh the tab, open a LinkedIn or JobStreet job listing, then select **Re-scan**. You can also enter details manually. |
| Chrome says the extension cannot access a page | Some pages do not allow extension access. Use manual entry, or click the extension icon on the desired tab and try **Re-scan**. |
| Sync fails | Check the Web App URL and API key in **Settings**, confirm the Apps Script deployment is available, then use **Test connection**. |
| Highlights are missing or incomplete | Re-scan after the job description loads. Detection depends on numeric year mentions near experience-related wording and can vary with page layout. |

## 👩‍💻 Development

The extension has no build step. To run the automated tests:

```sh
npm install
npm test
```

The tests use jsdom and mocked Chrome and Sheets APIs. They do not replace checking the extension in a live browser, against current job-site markup, and with your own Sheets deployment.

### 📁 Project layout

| Path | Purpose |
| --- | --- |
| `manifest.json`, `background.js` | Extension configuration and side panel behavior |
| `sidepanel/` | Tracker form, settings, and experience summary |
| `content/`, `content.js`, `content.css` | Page extraction and inline experience highlights |
| `utils/`, `services/` | Shared utilities and Sheets API client |
| `gas/` | Google Apps Script backend and setup guide |
| `test/` | Automated tests |
