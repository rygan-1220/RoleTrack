import { createJobFromExtraction, extractJobFromTab, syncJobForTab, validateJob } from './services/job-workflow.js';
import { getConfig, isConfigured } from './utils/storage.js';
import { pingApi } from './services/api.js';

// The native panel stays open while the user works on the job page.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

const WORKER_KEY = 'roleTrackWorkerTask';
const HEARTBEAT_KEY = 'roleTrackWorkerHeartbeat';
const APPLY_URL = /\/job\/\d+\/apply(?:[/?#]|$)/i;
const SG_JOB_URL = /^https:\/\/(?:sg\.jobstreet\.com|(?:www\.)?jobstreet\.com\.sg)\//i;

async function taskState() {
  return (await chrome.storage.local.get(WORKER_KEY))[WORKER_KEY] || null;
}

async function saveTask(update) {
  const current = (await taskState()) || {};
  const next = { ...current, ...update, updatedAt: Date.now() };
  await chrome.storage.local.set({ [WORKER_KEY]: next });
  return next;
}

async function content(tabId, message) {
  if (tabId == null) throw new Error('The RoleTrack helper tab is not available.');
  return chrome.tabs.sendMessage(tabId, message);
}

async function prepareJob({ taskId, tabId, url }) {
  if (tabId == null && url) {
    const requested = new URL(url);
    const matches = (await chrome.tabs.query({})).filter((tab) => {
      try { const actual = new URL(tab.url); return actual.origin === requested.origin && actual.pathname === requested.pathname; } catch { return false; }
    });
    tabId = matches[0]?.id;
  }
  const source = tabId == null ? null : await chrome.tabs.get(tabId).catch(() => null);
  if (!source?.url || (url && new URL(source.url).pathname !== new URL(url).pathname)) throw new Error('The job tab changed before the task started.');
  if (!SG_JOB_URL.test(source.url)) throw new Error('Worker v1 accepts Singapore JobStreet job links only.');
  const current = await taskState();
  if (current?.taskId && !['COMPLETED', 'FAILED', 'CANCELLED', 'REVIEW_REACHED'].includes(current.phase)) {
    throw new Error('Another RoleTrack worker task is already active.');
  }
  // Keep the user's Dry run preference. The worker uses the dedicated profile's
  // extension settings, just like the normal Quick Apply helper.
  await chrome.storage.local.set({ autoStart: false, workerMode: true });
  let task = await saveTask({ taskId, phase: 'EXTRACTING', sourceTabId: tabId, sourceUrl: source.url, applyTabId: null, pending: null, error: null });
  try {
    const extraction = await extractJobFromTab(tabId, source.url);
    const job = createJobFromExtraction(extraction, source.url);
    const validation = validateJob(job);
    if (validation) throw new Error(validation.message);
    const jobInfo = {
      company: job.company,
      role: job.role,
      location: job.location,
      salary: job.salary,
      employmentType: job.employmentType,
    };
    task = await saveTask({ phase: 'JOB_INFO_READY', jobInfo });
    return { ok: true, task, job };
  } catch (error) {
    await saveTask({ phase: 'FAILED', error: String(error?.message || error) });
    throw error;
  }
}

async function syncAndStartJob({ taskId, job }) {
  const prepared = await taskState();
  if (prepared?.taskId !== taskId || prepared.phase !== 'JOB_INFO_READY' || !prepared.sourceTabId) {
    throw new Error('Job details are not ready for Sheet sync. Start the worker task again.');
  }
  const source = await chrome.tabs.get(prepared.sourceTabId).catch(() => null);
  if (!source?.url || new URL(source.url).pathname !== new URL(prepared.sourceUrl).pathname) {
    throw new Error('The job tab changed before the Sheet sync started.');
  }
  const tabId = prepared.sourceTabId;
  try {
    const config = await getConfig();
    if (!isConfigured(config)) throw new Error('Configure the test Sheet in RoleTrack before running the worker.');
    await saveTask({ phase: 'SYNCING' });
    const result = await syncJobForTab(config, tabId, job);
    if (result.duplicate) {
      const task = await saveTask({ phase: 'WAITING_INPUT', pending: { kind: 'duplicate', prompt: 'This job is already in the Sheet. Skip the Sheet sync and continue to Quick Apply, or end the application?', duplicateType: result.duplicateType || null, existingRow: result.existingRow || null } });
      return { ok: true, waiting: true, duplicate: true, task };
    }
    if (!result.success) throw new Error(result.message || 'Google Sheets sync failed.');
    const task = await saveTask({ phase: 'STARTING_APPLY', sheetRow: result.row || null });
    await chrome.storage.local.set({ [WORKER_KEY]: task, [HEARTBEAT_KEY]: { taskId, at: Date.now() } });
    const started = await content(tabId, { type: 'roletrack-worker-helper', command: 'startJob' });
    if (!started?.ok) throw new Error(started?.message || 'Quick Apply could not be started.');
    return { ok: true, task };
  } catch (error) {
    await saveTask({ phase: 'FAILED', error: String(error?.message || error) });
    throw error;
  }
}

async function resolveDuplicate({ taskId, choice }) {
  const task = await taskState();
  if (task?.taskId !== taskId || task.phase !== 'WAITING_INPUT' || task.pending?.kind !== 'duplicate') {
    throw new Error('There is no duplicate decision awaiting an answer.');
  }
  if (choice === 'end') {
    return { ok: true, task: await saveTask({ phase: 'CANCELLED', pending: null, error: null }) };
  }
  if (choice !== 'continue') throw new Error('Choose continue or end.');
  const next = await saveTask({ phase: 'STARTING_APPLY', pending: null, sheetRow: null, error: null });
  await chrome.storage.local.set({ [WORKER_KEY]: next, [HEARTBEAT_KEY]: { taskId, at: Date.now() } });
  const started = await content(task.sourceTabId, { type: 'roletrack-worker-helper', command: 'startJob' });
  if (!started?.ok) throw new Error(started?.message || 'Quick Apply could not be started.');
  return { ok: true, task: next };
}

async function runStartJob(args) {
  const prepared = await prepareJob(args);
  return syncAndStartJob({ taskId: args.taskId, job: prepared.job });
}

chrome.tabs.onCreated.addListener((tab) => {
  if (APPLY_URL.test(tab.url || tab.pendingUrl || '')) taskForApplyTab(tab.id);
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (APPLY_URL.test(change.url || tab.url || '')) taskForApplyTab(tabId);
});
async function taskForApplyTab(tabId) {
  const task = await taskState();
  if (!task?.taskId || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.phase)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const sourceJobId = task.sourceUrl?.match(/(?:\/job\/|[?&]jobId=)(\d+)/i)?.[1];
  const applyJobId = tab?.url?.match(/\/job\/(\d+)\/apply/i)?.[1];
  if (!tab || !applyJobId || (sourceJobId && sourceJobId !== applyJobId)) return;
  await saveTask({ applyTabId: tabId, applyUrl: tab.url });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'roletrack-worker-event') {
    (async () => {
      const task = await taskState();
      if (!task || message.taskId !== task.taskId) return;
      await saveTask({ phase: message.phase || task.phase, pending: message.pending === undefined ? task.pending : message.pending, reviewUrl: message.reviewUrl || task.reviewUrl });
    })().catch(() => {});
    return;
  }
  if (message?.type === 'roletrack-close-current-tab') {
    if (_sender.tab?.id != null) chrome.tabs.remove(_sender.tab.id).catch(() => {});
    return;
  }
  if (message?.type !== 'roletrack-worker-command') return;
  (async () => {
    const { command, args = {} } = message;
    if (command === 'prepareJob') return prepareJob(args);
    if (command === 'syncAndStartJob') return syncAndStartJob(args);
    if (command === 'resolveDuplicate') return resolveDuplicate(args);
    if (command === 'startJob') return runStartJob(args);
    if (command === 'getTask') return taskState();
    if (command === 'getWorkerProtocol') return { version: chrome.runtime.getManifest().version, supportsResume: true, supportsPreparedJob: true, supportsDuplicateChoice: true, supportsWorkerDryRunPreference: true };
    if (command === 'heartbeat') {
      const task = await taskState();
      if (!task?.taskId || task.taskId !== args.taskId) throw new Error('Worker heartbeat does not match the active task.');
      const heartbeat = { taskId: task.taskId, at: Date.now() };
      await chrome.storage.local.set({ [HEARTBEAT_KEY]: heartbeat });
      return heartbeat;
    }
    if (command === 'checkCoverUpload') {
      const task = await taskState();
      if (task?.phase !== 'WAITING_INPUT' || task.pending?.kind !== 'coverLetter') throw new Error('There is no cover letter upload waiting.');
      return content(task.applyTabId, { type: 'roletrack-worker-helper', command: 'checkCoverUpload' });
    }
    if (command === 'checkJobPage') {
      const requested = args.url ? new URL(args.url) : null;
      const tabs = requested ? await chrome.tabs.query({}) : [];
      const tab = tabs.find((item) => {
        try { const actual = new URL(item.url); return actual.origin === requested.origin && actual.pathname === requested.pathname; } catch { return false; }
      });
      if (!tab) throw new Error('Job tab was not found.');
      return content(tab.id, { type: 'roletrack-worker-helper', command: 'checkJobPage' });
    }
    if (command === 'getSetupStatus') {
      const config = await getConfig();
      return { configured: isConfigured(config), dryRun: (await chrome.storage.local.get('dryRun')).dryRun !== false };
    }
    if (command === 'testSheet') {
      const config = await getConfig();
      if (!isConfigured(config)) throw new Error('Save the test Sheet URL and API key in RoleTrack Settings first.');
      const result = await pingApi(config);
      if (!result.success) throw new Error(result.message || 'Test Sheet connection failed.');
      return { success: true };
    }
    if (command === 'pauseTask') {
      const task = await taskState();
      if (!task || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.phase)) throw new Error('No active worker task to pause.');
      if (task.applyTabId != null) await content(task.applyTabId, { type: 'roletrack-worker-helper', command: 'pauseTask' }).catch(() => {});
      return saveTask({ phase: 'WAITING_BROWSER', pending: null });
    }
    if (command === 'cancelTask') {
      const task = await taskState();
      if (task?.applyTabId != null) await content(task.applyTabId, { type: 'roletrack-worker-helper', command: 'pauseTask' }).catch(() => {});
      return saveTask({ phase: 'CANCELLED', pending: null, error: 'Cancelled by user.' });
    }
    if (command === 'resetTask') {
      const task = await taskState();
      if (task?.taskId && !['COMPLETED', 'FAILED', 'CANCELLED', 'REVIEW_REACHED'].includes(task.phase)) throw new Error('An unfinished task exists. Use pause/resume or explicitly cancel it before starting another.');
      return saveTask({ taskId: null, phase: 'IDLE', pending: null, error: null, sourceTabId: null, sourceUrl: null, applyTabId: null });
    }
    if (command === 'resumeTask') {
      const task = await taskState();
      if (task?.phase !== 'WAITING_BROWSER') throw new Error('Task is not waiting for browser takeover.');
      const tab = task.applyTabId != null ? await chrome.tabs.get(task.applyTabId).catch(() => null) : null;
      if (!tab || !/jobstreet\./i.test(tab.url || '')) throw new Error('The Jobstreet takeover tab is not available to resume.');
      const resumed = await content(tab.id, { type: 'roletrack-worker-helper', command: 'resumeTask' });
      if (!resumed?.ok) throw new Error(resumed?.message || 'The helper could not resume.');
      return saveTask({ phase: resumed.phase || 'APPLYING', pending: null, error: null });
    }
    if (command === 'attachTask') {
      const task = await taskState();
      if (!task?.taskId || task.taskId !== args.taskId) throw new Error('Saved worker task does not match the requested task.');
      if (!['STARTING_APPLY', 'APPLYING', 'WAITING_INPUT', 'WAITING_BROWSER'].includes(task.phase)) throw new Error(`Cannot resume a saved task in phase ${task.phase}.`);
      const requested = new URL(args.url);
      const tab = (await chrome.tabs.query({})).find((item) => {
        try { const actual = new URL(item.url); return actual.origin === requested.origin && actual.pathname === requested.pathname; } catch { return false; }
      });
      if (!tab) throw new Error('Could not find the reopened JobStreet application tab.');
      await chrome.storage.local.set({ [HEARTBEAT_KEY]: { taskId: task.taskId, at: Date.now() } });
      const attached = await content(tab.id, { type: 'roletrack-worker-helper', command: 'attachTask', args: { paused: task.phase === 'WAITING_BROWSER', task } });
      if (!attached?.ok) throw new Error(attached?.message || 'RoleTrack could not attach to the saved task.');
      return saveTask({ applyTabId: tab.id, applyUrl: tab.url, phase: task.phase === 'WAITING_BROWSER' ? 'WAITING_BROWSER' : 'APPLYING', pending: null });
    }
    if (command === 'answerQuestion') {
      const task = await taskState();
      if (task?.phase !== 'WAITING_INPUT' || !task.pending) throw new Error('There is no current question awaiting an answer.');
      const p = task.pending;
      const a = args;
      if (a.taskId !== task.taskId || a.requestId !== p.requestId || a.questionId !== p.questionId || a.pageSignature !== p.pageSignature) {
        throw new Error('This answer belongs to an old question request.');
      }
      const result = await content(task.applyTabId, { type: 'roletrack-worker-helper', command: 'answerQuestion', args: a });
      if (!result?.ok) {
        if (result?.waiting) return { ...result, task };
        await saveTask({ phase: 'APPLYING', pending: null });
        throw new Error(result?.message || 'The page changed; the question will be read again.');
      }
      const next = await saveTask({ phase: result.waiting ? 'WAITING_INPUT' : 'APPLYING', pending: result.pending || null });
      return { ...result, task: next };
    }
    throw new Error(`Unknown worker command: ${command}`);
  })().then(sendResponse, (error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
