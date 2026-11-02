# RoleTrack

A single Chrome extension combining the job application tracker and experience highlighter. Clicking the toolbar icon opens a persistent native side panel alongside the page.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. If Experience Highlighter is already loaded from this folder, click **Reload**. Otherwise click **Load unpacked** and select `C:\Users\rygan\Downloads\job-exp-highlighter`.
3. Disable the old standalone Job Application Tracker to avoid using its popup by mistake.
4. Refresh any job tabs already open, pin the merged extension, and click its icon.
5. For a right panel, select **Chrome Settings > Appearance > Side panel > Right** if necessary. Chrome owns this preference; extensions cannot force the panel's position. See [Chrome's side panel guide](https://support.google.com/chrome/answer/13156494).

Requires Chrome 116+ or a Chromium browser supporting the Side Panel API. No build step is needed. The original `job-tracker-extension` folder is unchanged.

## Connect your Google Sheet

Use your existing Apps Script deployment and API key. Open **Settings** in the panel, paste the Web App URL (ending `/exec`) and key, test the connection, then save. The tracker settings belong to the old extension's storage, so enter them again in this merged extension. Existing sheet rows and duplicate detection continue to work with the same backend.

For a new spreadsheet, follow [gas/README.md](gas/README.md). The backend and sheet schema are unchanged.

## Use

- Open a LinkedIn or JobStreet listing. Experience mentions are highlighted inline automatically. The range and mention count appear in the panel, replacing the highlighter's floating banner. **Show highlight on page** scrolls to the first match.
- The panel reads company, role, salary, location, employment type, platform and URL. Review or edit the fields, choose a status and date, add notes, then click **Sync to Google Sheets**.
- Duplicate entries show **Cancel** and **Add anyway**, as before. Only clicking Sync or Add anyway writes to the sheet.
- The panel follows tab switches and job URL changes. Each tab/job has its own draft while the panel remains open. Re-scan preserves fields you edited on that job. Closing the panel clears these temporary drafts.
- Experience summaries track dynamically replaced descriptions. If a site switches jobs without changing its URL, click **Re-scan** to refresh the tracker fields. For a different job at the same URL, clear any manually edited fields as needed.
- Other job sites use the original generic extractor. After switching to an unfamiliar site, click the extension icon again to grant access, then Re-scan. Browser-internal pages support manual entry only.

## Permissions and limits

`sidePanel` opens the native panel; `tabs` identifies the active tab and URL as you browse; `activeTab` and `scripting` enable extraction; `storage` keeps your settings locally. Automatic page access is restricted to LinkedIn jobs and JobStreet, plus the Google Apps Script hosts used for syncing.

Experience matching requires a numeric year mention near an experience keyword in the same text block. Inline formatting is supported, but unusual wording, written-out numbers, and site layout changes can cause misses. A range summarizes all matches, which may represent different skills. Experience is displayed in the panel and is not added to the Google Sheet schema.

## Development

- `manifest.json`, `background.js`: native side panel registration and toolbar behavior.
- `sidepanel/`: responsive tracker form, settings and experience summary.
- `content.js`, `content.css`: automatic experience scanning and inline highlights.
- `content/`, `utils/`, `services/`: original job extractors, utilities and Sheets API client.
- `gas/`: Apps Script backend and setup instructions.
- `test/`: extraction, backend, panel, highlighter and utility tests.

Run `npm install` and `npm test`. Tests use jsdom and mocked Chrome/Sheets APIs. Live Chrome loading, current site markup, and your own Sheets connection still need a browser check.

## Browser check

1. Load/reload the extension. Click its icon on a job page: a resizable side panel opens and stays open when clicking the page.
2. Verify inline highlights and the experience summary; use Show highlight on page.
3. Edit a field and notes, switch tabs, then return: the edits remain.
4. Select another job, confirm the fields update, and Re-scan after delayed page loading if needed.
5. Test your connection, sync a reviewed job, then sync it again to check the duplicate warning.
