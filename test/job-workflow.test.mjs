import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobFromExtraction, syncJobForTab, validateJob } from '../services/job-workflow.js';

const baseJob = { company: 'Acme', role: 'Engineer', status: 'To Apply', url: 'https://sg.jobstreet.com/job/1' };

test('worker validation stops when required profile fields are missing', async () => {
  assert.equal(validateJob({ ...baseJob, company: '' }).field, 'company');
  assert.equal(validateJob({ ...baseJob, role: '' }).field, 'role');
  const result = await syncJobForTab({ apiUrl: 'unused', apiKey: 'secret' }, 12, { ...baseJob, company: '' });
  assert.equal(result.success, false);
  assert.equal(result.validation.field, 'company');
});

test('extraction becomes a To Apply Sheet row with a canonical URL', () => {
  const job = createJobFromExtraction({
    platform: { name: 'Jobstreet' },
    fields: { company: 'Acme', role: 'Engineer', salary: '$4K', location: 'Singapore', jobDescription: 'Role details' },
  }, 'https://sg.jobstreet.com/job/1?utm_source=mail#top', { status: 'To Apply' });
  assert.equal(job.company, 'Acme');
  assert.equal(job.status, 'To Apply');
  assert.equal(job.url, 'https://sg.jobstreet.com/job/1');
  assert.equal(job.jd, 'Role details');
});

test('only successful nonduplicate sync is returned as success and force is omitted', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let payload;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { text: async () => JSON.stringify({ success: true, row: 12 }) };
  };
  const result = await syncJobForTab({ apiUrl: 'https://script.google.com/macros/s/id/exec', apiKey: 'secret' }, 31, baseJob);
  assert.equal(result.success, true);
  assert.equal(result.row, 12);
  assert.equal(payload.status, 'To Apply');
  assert.equal(payload.force, undefined);
  assert.equal(payload.apiKey, 'secret');
});

test('duplicate sync remains a duplicate and is never forced', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({ text: async () => JSON.stringify({ success: false, duplicate: true, duplicateType: 'url' }) });
  const result = await syncJobForTab({ apiUrl: 'https://script.google.com/macros/s/id/exec', apiKey: 'secret' }, 31, baseJob);
  assert.equal(result.duplicate, true);
});
