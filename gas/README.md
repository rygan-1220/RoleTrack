# Apps Script backend

`Code.gs` is the whole backend: a Google Apps Script Web App bound to your spreadsheet. It receives JSON from the extension, validates it, checks for duplicates and appends a row.

## Setup

1. **Create the spreadsheet.** Go to <https://sheets.new> and name it, for example, "Job Applications". You can start with an empty sheet; the script creates the header row. If you already have a tracker, see [Using an existing sheet](#using-an-existing-sheet).
2. **Open Apps Script from the sheet:** *Extensions → Apps Script*. It must be opened from the sheet so the script is *bound* to it.
3. **Paste the code.** Delete the default `myFunction`, paste all of `Code.gs`, and click 💾 Save.
4. **Set the API key.** *Project Settings* (⚙️ in the left bar) → *Script properties* → *Add script property*:
   - Property: `API_KEY`
   - Value: a long random string (e.g. run `openssl rand -hex 24`, or use a password manager). You'll paste the same string into the extension.
5. **Authorise once.** In the editor pick the function `setup` and click **Run**. Approve the permissions (Google will warn the app is unverified — that's your own script; *Advanced → Go to … (unsafe)*). It creates the `Applications` tab and headers.
6. **Deploy.** *Deploy → New deployment* → gear icon → **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy** and copy the **Web app URL** (ends in `/exec`).
7. **Check it.** Open the URL in a browser. You should see `{"success":true,"message":"Job Tracker API is running…"}`.
8. Put the URL and API key in the extension's **Settings** and click **Test connection**.

### After editing `Code.gs`

The Web App serves a *saved version*, not your latest edit. Redeploy: *Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy*. The URL stays the same.

## Spreadsheet schema

Defined once, in `SCHEMA` at the top of `Code.gs`:

| Column | Field | Notes |
|---|---|---|
| Date | `date` | Real date value (sortable), written in the spreadsheet's time zone |
| Company | `company` | required |
| Role | `role` | required |
| Platform | `platform` | |
| Status | `status` | one of `STATUSES`, default *To Apply* |
| Salary | `salary` | free text |
| Location | `location` | |
| Employment Type | `employmentType` | |
| Job URL | `url` | |
| Notes | `notes` | |
| JD | `jd` | Extracted job description; text, up to 30,000 characters |
| Created At / Updated At | | set by the script |

Columns are matched by **header text** (or an alias such as *Position* for Role), so their order doesn't matter, and other columns you add are left alone. Change `SHEET_NAME` if your tab isn't called `Applications`.

### Using an existing sheet

Set `SHEET_NAME` to your tab's name. Headers that match (case-insensitive) are used as they are; missing ones (say, *Job URL*) are added to the right of your existing columns. Your existing rows are included in duplicate checks.

## API contract

`POST <web app URL>` with a JSON body (sent as `text/plain` to avoid a CORS preflight). Apps Script can't read HTTP headers, so the key is in the body.

```jsonc
{
  "apiKey": "…",
  "company": "ABC Technologies", "role": "AI Engineer", "platform": "LinkedIn",
  "status": "To Apply", "salary": "RM 5000 - RM 7000", "location": "Kuala Lumpur",
  "employmentType": "Full-time", "date": "2026-09-20", "url": "https://…", "notes": "",
  "force": false           // true = skip the duplicate check ("Add anyway")
}
```

Responses (always HTTP 200 with JSON; look at `success`):

```jsonc
{ "success": true,  "message": "Application added", "row": 152 }

{ "success": false, "duplicate": true, "duplicateType": "url",
  "message": "Possible duplicate application", "existingRow": 120,
  "existing": { "date": "2026-09-12", "company": "…", "role": "…", "platform": "…", "status": "Applied", "url": "…" } }

{ "success": false, "code": "invalid_api_key" | "invalid_request" | "missing_fields" | "server_not_configured" | "server_error",
  "message": "…" }
```

`{ "apiKey": "…", "action": "ping" }` checks the connection and key without writing anything.

## Duplicate rules

An entry is a duplicate only when **job URL, company name, and role/position all match** after normalization. The check will not flag a shared URL by itself or a shared company and role with a different URL. LinkedIn and JobStreet URLs reduce to their job id (so `…/jobs/view/123/?trackingId=…` matches `…?currentJobId=123`); other URLs lose tracking parameters, `#fragment`, `www.` and trailing slashes. Company and role are compared after lowercasing and treating punctuation as spaces (`ABC Tech Sdn. Bhd.` = `abc tech sdn bhd`). Nothing is ever overwritten: the client decides between *Cancel* and *Add anyway*.

## Security notes

- The `API_KEY` script property is the only secret. Keep it out of the code and the repo.
- "Anyone" access means the URL itself is public-if-leaked; the key is what stops strangers writing rows. It's a light lock for a personal tool, not real authentication.
- Values starting with `=`, `+`, `-`, `@` are stored as text so scraped page content can't become a spreadsheet formula.
- Errors are logged in *Executions* in the Apps Script editor; responses never include stack traces.
