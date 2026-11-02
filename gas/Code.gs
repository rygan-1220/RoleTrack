/**
 * Job Application Tracker — Google Apps Script backend (Web App).
 *
 * Bind this script to your Google Spreadsheet (Extensions -> Apps Script), then deploy it as a
 * Web App. The browser extension POSTs JSON here; this script validates it, checks for
 * duplicates and appends a row. See gas/README.md for the step-by-step setup.
 *
 * Nothing in here depends on the extension's UI — any client that sends the same JSON works.
 */

// ============================================================================
// CONFIG — the only section you should normally need to edit
// ============================================================================

/** Name of the tab that holds your applications. Created automatically if it doesn't exist. */
const SHEET_NAME = 'Applications';

const STATUSES = ['To Apply', 'Applied', 'OA / Assessment', 'Interview', 'Offer', 'Rejected', 'Withdrawn'];
const DEFAULT_STATUS = 'Applied';

/**
 * Column schema. This is the single source of truth for columns.
 *
 *  - Columns are found by HEADER TEXT (header, or any of `aliases`), not by position. So you can
 *    reorder columns freely, and an existing sheet with headers like "Company" / "Role" just works.
 *  - A header that is missing is appended to the right automatically.
 *  - To add a field: add a line here (and send it from the extension). To rename a column: change `header`.
 *
 * `format` is applied only to columns this script creates.
 */
const SCHEMA = [
  { key: 'date', header: 'Date', aliases: ['date applied', 'date saved'], format: 'dd mmm yyyy' },
  { key: 'company', header: 'Company', aliases: ['employer'] },
  { key: 'role', header: 'Role', aliases: ['position', 'job title', 'title'] },
  { key: 'platform', header: 'Platform', aliases: ['source', 'job board'] },
  { key: 'status', header: 'Status' },
  { key: 'salary', header: 'Salary' },
  { key: 'location', header: 'Location' },
  { key: 'employmentType', header: 'Employment Type', aliases: ['job type', 'type'] },
  { key: 'url', header: 'Job URL', aliases: ['url', 'link', 'job link'] },
  { key: 'notes', header: 'Notes' },
  { key: 'jd', header: 'JD', aliases: ['job description'] },
  { key: 'createdAt', header: 'Created At', format: 'yyyy-mm-dd hh:mm' },
  { key: 'updatedAt', header: 'Updated At', format: 'yyyy-mm-dd hh:mm' },
];

/** Max length for each text field (protects the sheet from junk / huge pastes). */
const LIMITS = { company: 200, role: 200, platform: 60, salary: 120, location: 160, employmentType: 60, url: 2048, notes: 2000, jd: 30000 };

// ============================================================================
// HTTP entry points
// ============================================================================

/** Opening the /exec URL in a browser shows this — handy to confirm the deployment is live. */
function doGet() {
  return json_({ success: true, message: 'Job Tracker API is running. Send a POST request to use it.' });
}

/**
 * POST body (JSON, sent as text/plain to avoid a CORS preflight):
 *   { apiKey, company, role, platform, status, salary, location, employmentType, date, url, notes, force? }
 *   { apiKey, action: "ping" }   -> connection test
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    const body = parseBody_(e);
    checkApiKey_(body.apiKey);

    if (body.action === 'ping') return json_({ success: true, message: 'Connected' });

    const job = validateJob_(body);

    // One writer at a time, so two quick syncs can't both pass the duplicate check.
    lock.waitLock(10000);
    locked = true;

    const sheet = getSheet_();
    const cols = getColumnMap_(sheet);

    const duplicate = body.force === true ? null : findDuplicate_(sheet, cols, job);
    if (duplicate) {
      return json_({
        success: false,
        duplicate: true,
        duplicateType: duplicate.type, // "url" (exact) or "company_role" (possible)
        message: duplicate.type === 'url' ? 'This job URL is already in your sheet.' : 'Possible duplicate application',
        existingRow: duplicate.row,
        existing: duplicate.record,
      });
    }

    const row = appendJob_(sheet, cols, job);
    return json_({ success: true, message: 'Application added', row: row });
  } catch (err) {
    if (err instanceof ApiError) return json_({ success: false, code: err.code, message: err.message });
    console.error(err && err.stack ? err.stack : err);
    return json_({ success: false, code: 'server_error', message: 'Something went wrong in the Apps Script backend. Check its Executions log.' });
  } finally {
    if (locked) lock.releaseLock();
  }
}

/** Run this once from the editor: grants permissions and creates/prepares the sheet. */
function setup() {
  const sheet = getSheet_();
  getColumnMap_(sheet);
  console.log('Ready. Sheet: ' + sheet.getName());
}

// ============================================================================
// Validation & normalisation
// ============================================================================

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseBody_(e) {
  try {
    const parsed = JSON.parse(e.postData.contents);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (err) {
    // fall through
  }
  throw new ApiError('invalid_request', 'Invalid request.');
}

function checkApiKey_(provided) {
  const expected = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!expected) {
    throw new ApiError('server_not_configured', 'The API_KEY script property is not set in Apps Script.');
  }
  if (typeof provided !== 'string' || provided !== expected) {
    throw new ApiError('invalid_api_key', 'Invalid API key. Check it in the extension settings.');
  }
}

function validateJob_(body) {
  const job = {};
  Object.keys(LIMITS).forEach(function (key) {
    job[key] = key === 'jd' ? normalizeMultilineText_(body[key]).slice(0, LIMITS[key]) : normalizeText_(body[key]).slice(0, LIMITS[key]);
  });

  if (!job.company) throw new ApiError('missing_fields', 'Company is required.');
  if (!job.role) throw new ApiError('missing_fields', 'Role is required.');

  job.status = normalizeText_(body.status) || DEFAULT_STATUS;
  if (STATUSES.indexOf(job.status) === -1) throw new ApiError('invalid_request', 'Unknown status: ' + job.status);

  job.date = normalizeText_(body.date) || todayIso_();
  if (!isValidIsoDate_(job.date)) throw new ApiError('invalid_request', 'Date must look like 2026-09-20.');

  if (job.url && !/^https?:\/\//i.test(job.url)) throw new ApiError('invalid_request', 'Job URL must start with http:// or https://');

  return job;
}

/** Collapse whitespace and trim. Non-strings become ''. */
function normalizeText_(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Preserve description paragraphs and list lines while normalising whitespace within each line. */
function normalizeMultilineText_(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(function (line) { return line.replace(/[\t\u00a0 ]+/g, ' ').trim(); })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function todayIso_() {
  return Utilities.formatDate(new Date(), getTimeZone_(), 'yyyy-MM-dd');
}

function isValidIsoDate_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

function getTimeZone_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
}

// ============================================================================
// Sheet access
// ============================================================================

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new ApiError('server_not_configured', 'This script must be bound to a spreadsheet (open it from the sheet: Extensions -> Apps Script).');
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Returns { key: zeroBasedColumnIndex } by matching header text. Appends any missing headers.
 */
function getColumnMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return normalizeText_(String(h)).toLowerCase(); }) : [];

  const cols = {};
  SCHEMA.forEach(function (field) {
    const names = [field.header].concat(field.aliases || []).map(function (n) { return n.toLowerCase(); });
    const index = headers.findIndex(function (h) { return names.indexOf(h) !== -1; });
    if (index !== -1) cols[field.key] = index;
  });

  SCHEMA.forEach(function (field) {
    if (field.key in cols) return;
    headers.push(field.header.toLowerCase());
    cols[field.key] = headers.length - 1;
    const headerCell = sheet.getRange(1, headers.length);
    headerCell.setValue(field.header).setFontWeight('bold');
    if (field.format && sheet.getMaxRows() > 1) {
      sheet.getRange(2, headers.length, sheet.getMaxRows() - 1, 1).setNumberFormat(field.format);
    }
  });

  return cols;
}

// ============================================================================
// Duplicate detection
// ============================================================================

/** Lowercase, punctuation -> space, collapse spaces. "ABC Tech. Sdn. Bhd." == "abc tech sdn bhd". Keeps + and # (C++, C#). */
function normalizeKey_(value) {
  return normalizeText_(String(value == null ? '' : value))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s+#]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reduce a job URL to something comparable.
 * LinkedIn / JobStreet URLs collapse to their job id, so a pasted
 * ".../jobs/view/123/?trackingId=..." matches the extension's canonical URL.
 * Other sites: lowercase, no protocol / www / #fragment / tracking params / trailing slash.
 * (Apps Script has no URL class, so this is string-based.)
 */
function normalizeUrl_(raw) {
  const url = normalizeText_(String(raw == null ? '' : raw)).toLowerCase();
  if (!url) return '';

  let m;
  if (/linkedin\.com/.test(url)) {
    m = /currentjobid=(\d+)/.exec(url) || /\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/.exec(url);
    if (m) return 'linkedin-job:' + m[1];
  }
  if (/jobstreet\./.test(url)) {
    m = /[?&]jobid=(\d+)/.exec(url) || /\/job\/(\d+)/.exec(url);
    if (m) return 'jobstreet-job:' + m[1];
  }

  const parts = url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('#')[0].split('?');
  const path = parts[0].replace(/\/+$/, '');
  const query = (parts[1] || '')
    .split('&')
    .filter(function (p) { return p && !/^(utm_[^=]*|fbclid|gclid|msclkid|ref|refid|referrer|trk|trackingid|src|source|campaign)(=|$)/.test(p); })
    .sort()
    .join('&');
  return query ? path + '?' + query : path;
}

/** Returns { type, row, record } or null. An exact URL match anywhere beats a company+role match. */
function findDuplicate_(sheet, cols, job) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const jobUrl = normalizeUrl_(job.url);
  const jobCompany = normalizeKey_(job.company);
  const jobRole = normalizeKey_(job.role);

  let companyRoleMatch = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowUrl = normalizeUrl_(row[cols.url]);
    if (jobUrl && rowUrl && jobUrl === rowUrl) return { type: 'url', row: i + 2, record: toRecord_(row, cols) };

    if (!companyRoleMatch && normalizeKey_(row[cols.company]) === jobCompany && normalizeKey_(row[cols.role]) === jobRole) {
      companyRoleMatch = { type: 'company_role', row: i + 2, record: toRecord_(row, cols) };
    }
  }
  return companyRoleMatch;
}

function toRecord_(row, cols) {
  const tz = getTimeZone_();
  const date = row[cols.date];
  return {
    date: date instanceof Date ? Utilities.formatDate(date, tz, 'yyyy-MM-dd') : String(date || ''),
    company: String(row[cols.company] || ''),
    role: String(row[cols.role] || ''),
    platform: String(row[cols.platform] || ''),
    status: String(row[cols.status] || ''),
    url: String(row[cols.url] || ''),
  };
}

// ============================================================================
// Writing
// ============================================================================

/**
 * Text scraped from web pages is untrusted. A value starting with = + - @ would be evaluated as a
 * formula by Sheets (e.g. =IMPORTXML(...) can leak data). A leading apostrophe forces plain text.
 */
function safeCell_(value) {
  return typeof value === 'string' && /^[=+\-@\t\r\n]/.test(value) ? "'" + value : value;
}

function appendJob_(sheet, cols, job) {
  const now = new Date();
  const values = {
    company: job.company,
    role: job.role,
    platform: job.platform,
    status: job.status,
    salary: job.salary,
    location: job.location,
    employmentType: job.employmentType,
    url: job.url,
    notes: job.notes,
    jd: job.jd,
    // Parsed in the spreadsheet's time zone so the date can't shift by a day.
    date: Utilities.parseDate(job.date, getTimeZone_(), 'yyyy-MM-dd'),
    createdAt: now,
    updatedAt: now,
  };

  const width = Math.max(sheet.getLastColumn(), Math.max.apply(null, Object.keys(cols).map(function (k) { return cols[k]; })) + 1);
  const rowValues = new Array(width).fill('');
  SCHEMA.forEach(function (field) {
    rowValues[cols[field.key]] = safeCell_(values[field.key] === undefined ? '' : values[field.key]);
  });

  const targetRow = sheet.getLastRow() + 1;
  sheet.getRange(targetRow, 1, 1, width).setValues([rowValues]);
  return targetRow;
}

// ============================================================================
// Helpers
// ============================================================================

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
