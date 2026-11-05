// Side panel controller: Detect -> Extract -> Review -> Sync -> optional Quick Apply.
// Quick Apply opens only after a successful sync or explicit duplicate override.

import { detectPlatform } from '../utils/platform.js';
import { todayISO, formatDisplay } from '../utils/date.js';
import { getConfig, saveConfig, isConfigured, isValidApiUrl } from '../utils/storage.js';
import { cleanJobUrl } from '../utils/url.js';
import { pingApi } from '../services/api.js';
import { extractJobFromTab, validateJob, syncJobForTab } from '../services/job-workflow.js';
import { STATUSES, DEFAULT_STATUS } from '../utils/status.js';

const DRAFTS_KEY = 'jobTrackerDrafts';

// Fields the page extraction can fill (each one gets a "read from page" dot).
const EXTRACTED = ['company', 'role', 'salary', 'location', 'employmentType', 'url', 'jd'];
const ALL_FIELDS = ['platform', 'company', 'role', 'salary', 'location', 'employmentType', 'status', 'date', 'url', 'notes', 'jd'];

const $ = (id) => document.getElementById(id);
const field = (key) => $('f-' + key);

const state = {
  tab: null,
  platform: null,
  config: null,
  dirty: new Set(), // fields the user edited; a re-scan won't overwrite these
  scanning: false,
  syncing: false,
  scanId: 0,
  pageKey: null,
  drafts: new Map(),
  pendingRefresh: false,
  pendingApplyAfterDuplicate: false,
  domRefreshTimer: null,
};

// ------------------------------------------------------------------ small UI helpers

function setBanner(kind, text, el = $('banner')) {
  el.hidden = !text;
  el.textContent = text || '';
  el.dataset.kind = kind;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}

function setProvenance(key, found) {
  const dot = document.querySelector(`.dot[data-for="${key}"]`);
  if (!dot) return;
  dot.classList.toggle('found', found);
  dot.title = found ? 'Read from the page' : 'Not found on the page';
}

function setStatusDot() {
  $('status-dot').dataset.status = field('status').value;
}

const SYNC_LABELS = {
  idle: 'Sync + Quick Apply',
  syncing: 'Syncing…',
  success: '✓ Synced successfully',
  failed: '✕ Sync failed',
};

function setSyncButton(name) {
  const button = $('sync');
  button.dataset.state = name;
  button.textContent = SYNC_LABELS[name];
  button.disabled = name !== 'idle'; // blocks accidental double submits
  const syncOnlyButton = $('sync-only');
  syncOnlyButton.dataset.state = name;
  syncOnlyButton.disabled = name !== 'idle';
}

function markInvalid(key, invalid) {
  const row = document.querySelector(`[data-row="${key}"]`);
  if (row) row.classList.toggle('invalid', invalid);
}

function showView(name) {
  $('view-main').hidden = name !== 'main';
  $('view-settings').hidden = name !== 'settings';
}

function hideDuplicate() {
  $('duplicate').hidden = true;
  $('sync-area').hidden = false;
}

function showDuplicate(result) {
  const existing = result.existing || {};
  $('dupe-title').textContent =
    result.duplicateType === 'url' ? 'You already saved this job.' : 'Possible duplicate application found.';
  $('dupe-company').textContent = existing.company || 'Existing entry';
  $('dupe-role').textContent = existing.role || '';
  $('dupe-status').textContent = existing.status || '—';
  $('dupe-date').textContent = existing.date ? formatDisplay(existing.date) : '—';
  $('dupe-row').textContent = result.existingRow ? String(result.existingRow) : '—';
  $('duplicate').hidden = false;
  $('sync-area').hidden = true;
}

// ------------------------------------------------------------------ extraction

function setField(key, value) {
  field(key).value = value || '';
}

async function scan() {
  if (state.syncing) { state.pendingRefresh = true; return; }
  const scanId = ++state.scanId;
  state.scanning = true;
  $('rescan').disabled = true;
  setBanner('info', 'Reading this page…');

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (scanId !== state.scanId) return;
  const nextKey = activeTab ? `${activeTab.id}:${cleanJobUrl(activeTab.url || '')}` : 'none';
  if (nextKey !== state.pageKey) {
    if (state.pageKey) await saveDraft(state.pageKey);
    state.pageKey = nextKey;
    const draft = state.drafts.get(nextKey);
    state.dirty = draft ? new Set(draft.dirty) : new Set();
    for (const key of ALL_FIELDS) setField(key, draft?.fields[key]);
    if (!draft) {
      field('date').value = todayISO();
      field('status').value = DEFAULT_STATUS;
    }
    for (const key of EXTRACTED) setProvenance(key, false);
    for (const key of ['company', 'role', 'url']) markInvalid(key, false);
    setStatusDot();
    hideDuplicate();
    setSyncButton('idle');
  }
  state.tab = activeTab || null;
  state.platform = detectPlatform(activeTab?.url || '');
  const platform = state.platform;
  if (!state.dirty.has('platform')) field('platform').value = state.platform.name;
  showExperience(null);

  let result = null;
  const tab = state.tab;
  const isGoogleWorkspacePage = /^https:\/\/(?:docs|drive)\.google\.com\//i.test(tab?.url || '');
  // Browser-internal pages (chrome://, the Web Store, PDFs viewers…) can't be scripted.
  if (!isGoogleWorkspacePage && tab && tab.id != null && /^https?:/i.test(tab.url || '')) {
    try {
      result = await extractJobFromTab(tab.id, tab.url);
    } catch (err) {
      // Chrome rejects injection on tabs without a current activeTab grant (for
      // example, when the panel follows a tab switch). This is an expected
      // limitation, so keep it out of the console; manual entry still works.
      const message = String(err?.message || err || '');
      if (!/Cannot access contents|must request permission|cannot access.*url/i.test(message)) {
        console.warn('[job-tracker] page extraction failed', err);
      }
    }
  }

  if (scanId !== state.scanId) return; // Ignore a response from a tab we have left.
  applyExtraction(result);
  if (isGoogleWorkspacePage) setBanner('info', 'Google Workspace page detected. Enter job details manually, then sync to your tracker.');
  showExperience(result?.experience);
  state.scanning = false;
  $('rescan').disabled = false;
}

function showExperience(result) {
  const range = result?.range;
  $('show-experience').hidden = !range;
  if (!result?.available) {
    $('experience-summary').textContent = state.platform?.key === 'generic'
      ? 'Experience highlighting is available on LinkedIn and Jobstreet.'
      : 'Open a job description, then click Re-scan.';
  } else if (!range) {
    $('experience-summary').textContent = 'No experience requirement detected.';
  } else {
    const years = range.min === range.max ? `${range.min}` : `${range.min}–${range.max}`;
    $('experience-summary').innerHTML = `<strong>${years}${range.plus ? '+' : ''} years</strong> / ${result.count} ${result.count === 1 ? 'mention' : 'mentions'}`;
  }
}

function applyExtraction(result) {
  const pageUrl = (state.tab && state.tab.url) || '';
  const fields = result && result.ok ? result.fields : {};

  for (const key of EXTRACTED) {
    if (state.dirty.has(key)) continue;
    if (key === 'url') {
      const url = cleanJobUrl(fields.url || pageUrl);
      setField('url', url);
      setProvenance('url', Boolean(url));
    } else {
      setField(key, fields[key]);
      setProvenance(key, Boolean(fields[key]));
    }
  }
  if (fields.jobDescription !== undefined && !state.dirty.has('jd')) {
    setField('jd', fields.jobDescription);
    setProvenance('jd', Boolean(fields.jobDescription));
  }

  // Judge what to tell the user from what is in the form now (they may have typed something).
  const hasCompany = Boolean(field('company').value.trim());
  const hasRole = Boolean(field('role').value.trim());

  if (!result || !result.ok) {
    const readable = /^https?:/i.test(pageUrl);
    setBanner(readable ? 'info' : 'warn', readable ? 'Enter job details manually, or open a supported job listing.' : "This page can't be read by extensions. Enter the details manually.");
  } else if (hasCompany && hasRole) {
    setBanner('info', 'Job information extracted. Please review before syncing.');
  } else if (hasRole) {
    setBanner('warn', 'Company name could not be detected. Please fill it in.');
  } else if (hasCompany) {
    setBanner('warn', 'Job title could not be detected. Please fill it in.');
  } else if (state.platform.key === 'generic') {
    setBanner('warn', "This site isn't supported yet and no job details were found. Enter them manually.");
  } else {
    setBanner('warn', 'No job details found. Open a specific job listing, or enter them manually.');
  }

  if (!hasCompany) field('company').focus();
  else if (!hasRole) field('role').focus();
}

// ------------------------------------------------------------------ form <-> job

function readForm() {
  const job = {};
  for (const key of ALL_FIELDS) job[key] = field(key).value.trim();
  return job;
}

async function saveDraft(key = state.pageKey) {
  if (!key) return;
  const draft = { fields: readForm(), dirty: [...state.dirty], savedAt: Date.now() };
  state.drafts.set(key, { ...draft, dirty: new Set(draft.dirty) });
  const stored = await chrome.storage.local.get(DRAFTS_KEY);
  await chrome.storage.local.set({ [DRAFTS_KEY]: { ...(stored[DRAFTS_KEY] || {}), [key]: draft } });
}

// ------------------------------------------------------------------ sync

async function startQuickApply() {
  if (!state.tab?.id || state.platform?.key !== 'jobstreet') {
    setBanner('warn', 'Saved to Google Sheets. Open a Jobstreet Quick Apply listing to start the application.');
    return;
  }
  try {
    const result = await chrome.tabs.sendMessage(state.tab.id, { type: 'roletrack-start-quick-apply' });
    if (result?.ok) setBanner('success', 'Saved to Sheets. Opening Jobstreet Quick Apply…');
    else setBanner('warn', `Saved to Sheets. ${result?.message || 'Quick Apply could not be started.'}`);
  } catch {
    setBanner('warn', 'Saved to Sheets, but the Jobstreet helper is unavailable. Reload RoleTrack and refresh the job tab.');
  }
}

async function onSync({ force = false, startApply = false } = {}) {
  if (state.syncing || state.scanning) return;

  for (const key of ['company', 'role', 'url']) markInvalid(key, false);
  const job = readForm();
  const problem = validateJob(job);
  if (problem) {
    markInvalid(problem.field, true);
    setBanner('error', problem.message);
    field(problem.field).focus();
    return;
  }
  if (!isConfigured(state.config)) {
    openSettings('Add your Web App URL and API key to start syncing.');
    return;
  }

  state.syncing = true;
  setSyncButton('syncing');
  $('dupe-add').disabled = true;
  setBanner('info', 'Sending to Google Sheets…');

  const result = await syncJobForTab(state.config, state.tab?.id, job, { force });

  state.syncing = false;
  $('dupe-add').disabled = false;

  if (result.success) {
    hideDuplicate();
    setSyncButton('success');
    setBanner('success', result.row ? `Saved to your sheet (row ${result.row}).` : 'Saved to your sheet.');
    state.pendingApplyAfterDuplicate = false;
    if (startApply) await startQuickApply();
  } else if (result.duplicate) {
    setSyncButton('idle');
    state.pendingApplyAfterDuplicate = startApply;
    setBanner('warn', result.duplicateType === 'url' ? 'This job URL is already in your sheet.' : 'Possible duplicate application found.');
    showDuplicate(result);
  } else {
    state.pendingApplyAfterDuplicate = false;
    hideDuplicate();
    setSyncButton('failed');
    setBanner('error', result.message || 'Unable to connect to Google Sheets.');
  }
  if (state.pendingRefresh) {
    state.pendingRefresh = false;
    await scan();
  }
}

// ------------------------------------------------------------------ settings

async function openSettings(message) {
  $('s-apiUrl').value = state.config.apiUrl;
  $('s-apiKey').value = state.config.apiKey;
  const preferences = await chrome.storage.local.get(['dryRun', 'submitCountdownSeconds', 'autoStart', 'manualCoverLetter']);
  $('s-dryRun').checked = preferences.dryRun !== false;
  const countdown = [0, 3, 5, 10].includes(Number(preferences.submitCountdownSeconds))
    ? Number(preferences.submitCountdownSeconds)
    : 5;
  $('s-submitCountdown').value = String(countdown);
  $('s-autoStart').checked = preferences.autoStart === true;
  $('s-manualCoverLetter').checked = preferences.manualCoverLetter === true;
  setBanner('info', message, $('settings-msg'));
  showView('settings');
  $('s-apiUrl').focus();
}

async function saveQuickApplyPreferences() {
  const status = $('quick-apply-settings-status');
  try {
    await chrome.storage.local.set({
      dryRun: $('s-dryRun').checked,
      submitCountdownSeconds: Number($('s-submitCountdown').value),
      autoStart: $('s-autoStart').checked,
      manualCoverLetter: $('s-manualCoverLetter').checked,
    });
    status.textContent = 'Changes saved.';
  } catch {
    status.textContent = 'Could not save these settings. Try reloading RoleTrack.';
  }
}

function readSettingsForm() {
  return { apiUrl: $('s-apiUrl').value.trim(), apiKey: $('s-apiKey').value.trim() };
}

function settingsProblem({ apiUrl, apiKey }) {
  if (!isValidApiUrl(apiUrl)) {
    return 'That does not look like an Apps Script Web App URL. It should start with https://script.google.com/macros/s/ and end with /exec.';
  }
  if (!apiKey) return 'Enter your API key.';
  return '';
}

async function onSaveSettings() {
  const values = readSettingsForm();
  const problem = settingsProblem(values);
  if (problem) return setBanner('error', problem, $('settings-msg'));

  state.config = await saveConfig(values);
  showView('main');
  setBanner('success', 'Settings saved. Review the details, then sync.');
}

async function onTestConnection() {
  const values = readSettingsForm();
  const problem = settingsProblem(values);
  if (problem) return setBanner('error', problem, $('settings-msg'));

  $('test-connection').disabled = true;
  setBanner('info', 'Testing connection…', $('settings-msg'));
  const result = await pingApi(values);
  $('test-connection').disabled = false;
  setBanner(result.success ? 'success' : 'error', result.success ? 'Connected. Your URL and API key work.' : result.message, $('settings-msg'));
}

// ------------------------------------------------------------------ wiring

function onFieldInput(key) {
  state.dirty.add(key);
  saveDraft();
  if (EXTRACTED.includes(key)) setProvenance(key, false); // now "entered by you"
  if (key === 'status') setStatusDot();
  markInvalid(key, false);

  // Any edit after a finished sync re-arms the button and clears a stale duplicate warning.
  if (!state.syncing && ['success', 'failed'].includes($('sync').dataset.state)) setSyncButton('idle');
  if (!$('duplicate').hidden) hideDuplicate();
}

async function init() {
  for (const status of STATUSES) field('status').add(new Option(status, status));
  field('status').value = DEFAULT_STATUS;
  setStatusDot();
  field('date').value = todayISO();

  for (const key of ALL_FIELDS) {
    const eventName = key === 'status' || key === 'date' ? 'change' : 'input';
    field(key).addEventListener(eventName, () => onFieldInput(key));
  }
  $('sync').addEventListener('click', () => onSync({ startApply: true }));
  $('sync-only').addEventListener('click', () => onSync());
  $('dupe-add').addEventListener('click', () => onSync({ force: true, startApply: state.pendingApplyAfterDuplicate }));
  $('dupe-cancel').addEventListener('click', () => {
    state.pendingApplyAfterDuplicate = false;
    hideDuplicate();
    setBanner('info', 'Not added. You can edit the details and sync again.');
  });
  $('rescan').addEventListener('click', scan);
  $('open-settings').addEventListener('click', () => openSettings(''));
  $('close-settings').addEventListener('click', () => showView('main'));
  $('s-dryRun').addEventListener('change', saveQuickApplyPreferences);
  $('s-submitCountdown').addEventListener('change', saveQuickApplyPreferences);
  $('s-autoStart').addEventListener('change', saveQuickApplyPreferences);
  $('s-manualCoverLetter').addEventListener('change', saveQuickApplyPreferences);
  $('save-settings').addEventListener('click', onSaveSettings);
  $('test-connection').addEventListener('click', onTestConnection);
  $('show-experience').addEventListener('click', async () => {
    if (!state.tab?.id) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId: state.tab.id }, func: () => window.JobExperience?.jump() });
    } catch { setBanner('warn', 'The page changed. Click Re-scan to refresh the highlights.'); }
  });

  state.config = await getConfig();
  const savedDrafts = (await chrome.storage.local.get(DRAFTS_KEY))[DRAFTS_KEY] || {};
  for (const [key, draft] of Object.entries(savedDrafts)) {
    state.drafts.set(key, { ...draft, dirty: new Set(draft.dirty || []) });
  }

  chrome.tabs.onActivated?.addListener(() => scan());
  chrome.tabs.onUpdated?.addListener((tabId, change) => {
    if (tabId === state.tab?.id && (change.url || change.status === 'complete')) scan();
  });
  chrome.runtime?.onMessage?.addListener((message, sender) => {
    if (message.type === 'experience-updated' && sender.tab?.id === state.tab?.id) {
      showExperience(message.result);
      // Experience's observer also signals SPA job switches where the URL stays unchanged.
      clearTimeout(state.domRefreshTimer);
      state.domRefreshTimer = setTimeout(() => scan(), 350);
    }
  });

  if (!isConfigured(state.config)) openSettings('First, connect your Google Sheet: paste the Web App URL and API key.');
  await scan();
}

init();
