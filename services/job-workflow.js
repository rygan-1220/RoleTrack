// Shared tab-scoped extraction, validation, and sync orchestration for the panel and worker.
import { detectPlatform, scriptsFor } from '../utils/platform.js';
import { cleanJobUrl } from '../utils/url.js';
import { STATUSES, DEFAULT_STATUS } from '../utils/status.js';
import { todayISO } from '../utils/date.js';
import { syncJob } from './api.js';

export const REQUIRED_JOB_FIELDS = ['company', 'role'];

export function validateJob(job) {
  if (!job?.company?.trim()) return { field: 'company', message: 'Add the company name before syncing.' };
  if (!job?.role?.trim()) return { field: 'role', message: 'Add the role before syncing.' };
  if (job.url && !/^https?:\/\//i.test(job.url)) return { field: 'url', message: 'Job URL must start with http:// or https://' };
  if (!STATUSES.includes(job.status)) return { field: 'status', message: 'Choose a status.' };
  return null;
}

export async function extractJobFromTab(tabId, pageUrl = '') {
  if (tabId == null) throw new Error('A browser tab ID is required for extraction.');
  const platform = detectPlatform(pageUrl);
  await chrome.scripting.executeScript({ target: { tabId }, files: scriptsFor(platform) });
  if (platform.key !== 'generic') await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (platformKey) => {
      const result = await window.JobTracker.run(platformKey);
      result.experience = window.JobExperience?.scan() || null;
      return result;
    },
    args: [platform.key],
  });
  const result = injection?.result;
  if (!result?.ok) throw new Error(result?.error || 'Job details could not be extracted.');
  return { ...result, platform };
}

export function createJobFromExtraction(result, pageUrl, { status = DEFAULT_STATUS, date = todayISO() } = {}) {
  const fields = result?.fields || {};
  return {
    platform: result?.platform?.name || detectPlatform(pageUrl).name,
    company: String(fields.company || '').trim(),
    role: String(fields.role || '').trim(),
    salary: String(fields.salary || '').trim(),
    location: String(fields.location || '').trim(),
    employmentType: String(fields.employmentType || '').trim(),
    status,
    date,
    url: cleanJobUrl(fields.url || pageUrl),
    notes: '',
    jd: String(fields.jobDescription || fields.jd || '').trim(),
  };
}

export async function syncJobForTab(config, tabId, job, { force = false } = {}) {
  // tabId is explicit so a worker never depends on whichever page happens to be active.
  // The panel also passes its active tab, but can still sync manually entered details.
  const problem = validateJob(job);
  if (problem) return { success: false, validation: problem };
  return syncJob(config, job, { force });
}
