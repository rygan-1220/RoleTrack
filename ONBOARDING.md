# RoleTrack onboarding guide

This guide is for someone setting up the project locally, learning how its pieces fit together, and making a small change safely. RoleTrack is a Manifest V3 Chrome extension with no build step. Its optional backend is a Google Apps Script web app bound to a spreadsheet.

## 1. Prerequisites

- Chrome 116 or later, or a Chromium browser with the Side Panel API.
- Git and an editor such as VS Code.
- A Google account and Google Sheets only if you want to test syncing or Quick Apply end to end.

There is no Node.js dependency installation for the current repository: it has no `package.json`, lockfile, or checked-in test directory. The extension source runs directly from this folder.

## 2. Run the extension locally

1. Clone or open this repository in your editor.
2. In Chrome, visit `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the repository root, the folder containing `manifest.json`.
4. Open a LinkedIn or Jobstreet job listing, refresh it if it was already open, then click the RoleTrack toolbar icon.
5. Edit a field and use **Sync only** after configuring the optional Sheets backend. Use **Re-scan** to rerun extraction after the listing loads.

After editing extension files, return to `chrome://extensions`, click **Reload** on RoleTrack, and refresh the job listing tab. Content scripts already injected in a page keep the old code until the page is refreshed.

## 3. Connect a private Google Sheets backend

Follow the full setup in [`gas/README.md`](gas/README.md). In short, create/open a spreadsheet, bind the contents of `gas/Code.gs` through **Extensions → Apps Script**, set the `API_KEY` script property, run `setup` once to authorize and create the sheet schema, and deploy as a Web App executing as you with access set to **Anyone**. Copy the deployed `/exec` URL.

In RoleTrack, open **Settings**, enter that URL and the same API key, select **Test connection**, then **Save**. The extension keeps these settings in `chrome.storage.local` in that browser profile. The API key is not stored in this repository. The public web-app endpoint relies on that key as a lightweight personal-tool lock; keep both the URL and key private.

When you change `gas/Code.gs`, save and deploy a **new version** from **Deploy → Manage deployments**. The deployment URL remains the same, but edits in the script editor do not update an existing deployed version by themselves.

## 4. How the pieces fit together

| Area | Responsibility |
|---|---|
| `manifest.json` | Permissions, host access, side panel entry point, and page content scripts. |
| `background.js` | Opens the native side panel on toolbar click and handles closing the active tab after the helper submits. |
| `sidepanel/sidepanel.html`, `sidepanel/sidepanel.js`, `sidepanel/sidepanel.css` | Tracker form, settings, extraction coordination, sync actions, and helper controls. |
| `content/extractors/` | Site-specific and generic job-field extraction. `utils/platform.js` maps supported hosts to extractors. |
| `content/content.js`, `content.js`, `content.css` | Page-side extraction entry point, injected highlight behavior, and highlight styling. |
| `content/jobstreet-qa-helper.js` | Jobstreet Quick Apply controller, page overlay, question handling, and submit flow. |
| `services/api.js` | POST requests to the Apps Script Web App, including timeout and response handling. |
| `utils/storage.js` | Local extension configuration storage and Apps Script URL validation. |
| `utils/` | Shared platform, date, URL, and storage helpers. |
| `gas/Code.gs` | Spreadsheet schema, API key validation, duplicate detection, and row writes. |

For a new job site, begin with the extension host access and content-script match patterns in `manifest.json`, then add a site extractor and register it in `utils/platform.js`. Keep site-specific selectors inside its extractor. For Jobstreet markup changes, the Quick Apply selectors are grouped near the top of `content/jobstreet-qa-helper.js`.

To customize the status choices, edit `STATUSES` and `DEFAULT_STATUS` in `utils/status.js`. The extension uses this shared config, while the Apps Script backend accepts any non-empty status, so no matching edit in `gas/Code.gs` is needed.

## 5. Safe development loop

1. Make a focused change in the owning module and keep secrets, personal job data, and deployed URLs out of commits.
2. Reload the extension in `chrome://extensions` and refresh the relevant listing tab.
3. Check both the side panel and the page behavior. Use the extension's **Re-scan** action when testing extraction; check the page console for content-script errors and the extension's service worker console for background errors.
4. For sync work, use **Test connection** and verify a test row in a non-sensitive test spreadsheet.
5. For Quick Apply work, leave **Settings → Dry run** enabled. In dry run, the helper proceeds through the flow and stops at Review without clicking the final submit button. Only disable dry run when deliberately validating a real submission.
6. Review `git diff` before committing, especially changes to permissions, host patterns, selectors, and spreadsheet schema.

The current repository does not include an automated test command, despite the older Development paragraph in `README.md` mentioning `npm install` and `npm test`. Verify changes in the browser unless and until a test harness is added.

## 6. Before sharing or releasing

- Confirm `manifest.json` version and permissions match the change.
- Exercise extraction on supported pages and manual entry on an unsupported page.
- Confirm local settings, duplicate handling, and successful syncing against a test sheet if the backend changed.
- For Quick Apply changes, verify pause/stop behavior and dry run at Review; avoid submitting an application during routine checks.
- Update the relevant README or `gas/README.md` when setup, user-visible behavior, schema, or deployment steps change.
- Do not commit the API key, private spreadsheet contents, browser profile data, or application credentials.
