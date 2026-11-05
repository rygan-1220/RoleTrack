import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let browser;

before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function application(html, expectedPhase = 'WAITING_INPUT', { heartbeatAge = 0 } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (message) => { if (message.type() === 'error') console.error('Page console:', message.text()); });
  await page.route('https://sg.jobstreet.com/job/1/apply', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>${html}</body></html>` }));
  await page.goto('https://sg.jobstreet.com/job/1/apply');
  await page.addInitScript(({ heartbeatAge }) => {
    const data = {
      roleTrackWorkerTask: { taskId: 'test-task', phase: 'APPLYING' },
      roleTrackWorkerHeartbeat: { taskId: 'test-task', at: Date.now() - heartbeatAge },
    };
    const listeners = [];
    window.__messages = [];
    window.__workerData = data;
    window.__runtimeListeners = listeners;
    window.__QA_TEST = true;
    window.chrome = {
      storage: {
        local: {
          async get(keys) {
            if (typeof keys === 'string') return { [keys]: data[keys] };
            if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, data[key]]));
            return { ...data };
          },
          async set(values) { Object.assign(data, values); },
          async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
        },
        onChanged: { addListener() {} },
      },
      runtime: {
        onMessage: { addListener(listener) { listeners.push(listener); } },
        sendMessage(message) { window.__messages.push(message); return Promise.resolve(); },
      },
    };
    sessionStorage.setItem('qa_active', '1');
  }, { heartbeatAge });
  // addInitScript must be installed before navigation; re-navigate through the same route.
  await page.reload();
  await page.addScriptTag({ path: path.join(ROOT, 'content/jobstreet-qa-helper.js') });
  try {
    await page.waitForFunction((phase) => window.__messages.some((message) => message?.type === 'roletrack-worker-event' && message.phase === phase), expectedPhase, { timeout: 5000 });
  } catch (error) {
    console.error('Helper debug:', await page.evaluate(() => ({ messages: window.__messages, overlay: document.querySelector('[data-qa="msg"]')?.textContent, html: document.body.innerHTML })));
    throw error;
  }
  return { context, page };
}

async function pending(page) {
  return page.evaluate(() => window.__messages.findLast((message) => message?.type === 'roletrack-worker-event' && message.phase === 'WAITING_INPUT')?.pending);
}

async function answer(page, args) {
  return page.evaluate((args) => new Promise((resolve) => {
    const listener = window.__runtimeListeners[0];
    listener({ type: 'roletrack-worker-helper', command: 'answerQuestion', args }, {}, resolve);
  }), args);
}

async function helperCommand(page, command, args = {}) {
  return page.evaluate(({ command, args }) => new Promise((resolve) => {
    window.__runtimeListeners[0]({ type: 'roletrack-worker-helper', command, args }, {}, resolve);
  }), { command, args });
}

test('radio question exposes full prompt and options, blocks Continue until answer, then fills and continues', async () => {
  const { context, page } = await application(`<h1>Application</h1><fieldset id="salary" role="radiogroup"><legend>What is your expected monthly basic salary?</legend><label><input type="radio" name="questionnaire.salary" id="salary-low" value="3000">$3K</label><label><input type="radio" name="questionnaire.salary" id="salary-mid" value="4000">$4K</label><label><input type="radio" name="questionnaire.salary" id="salary-high" value="5000">$5K</label></fieldset><button data-testid="continue-button">Continue</button><output id="clicks">0</output><script>document.querySelector('button').onclick=()=>document.querySelector('#clicks').textContent=String(Number(document.querySelector('#clicks').textContent)+1)</script>`);
  try {
    const request = await pending(page);
    assert.equal(request.prompt, 'What is your expected monthly basic salary?');
    assert.deepEqual(request.options.map((option) => option.text), ['$3K', '$4K', '$5K']);
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#clicks').textContent(), '0');
    const response = await answer(page, { ...request, optionId: 'salary-mid', value: '4000' });
    assert.equal(response.ok, true);
    await page.waitForFunction(() => document.querySelector('#clicks').textContent === '1', null, { timeout: 1500 });
    assert.equal(await page.locator('#salary-mid').isChecked(), true);
    const duplicate = await answer(page, { ...request, optionId: 'salary-low', value: '3000' });
    assert.equal(duplicate.ok, false);
    assert.equal(await page.locator('#salary-mid').isChecked(), true);
  } finally { await context.close(); }
});

test('prefilled select answer requires confirmation and disabled options are retained as disabled', async () => {
  const { context, page } = await application(`<h1>Application</h1><div><label for="notice">Notice period</label><select id="notice" name="questionnaire.notice" required><option value="30" selected>30 days</option><option value="60">60 days</option><option value="90" disabled>90 days</option></select></div><button data-testid="continue-button">Continue</button>`);
  try {
    const request = await pending(page);
    assert.equal(request.controlType, 'select');
    assert.equal(request.currentAnswer, '30');
    assert.deepEqual(request.options.map((option) => [option.text, option.disabled]), [['30 days', false], ['60 days', false], ['90 days', true]]);
    const disabled = await answer(page, { ...request, optionId: '', value: '90' });
    assert.equal(disabled.ok, false);
    assert.equal(await page.locator('#notice').inputValue(), '30');
    await page.waitForFunction(() => window.__messages.filter((message) => message?.phase === 'WAITING_INPUT').length > 1, null, { timeout: 1500 });
    const refreshed = await pending(page);
    const response = await answer(page, { ...refreshed, optionId: '', value: '60' });
    assert.equal(response.ok, true);
    assert.equal(await page.locator('#notice').inputValue(), '60');
  } finally { await context.close(); }
});

test('text questions accept and verify text answers', async () => {
  const { context, page } = await application(`<h1>Application</h1><label>Phone number <input id="phone" name="questionnaire.phone" type="tel" required value=""></label><button data-testid="continue-button">Continue</button>`);
  try {
    const request = await pending(page);
    assert.equal(request.controlType, 'tel');
    assert.match(request.prompt, /Phone number/);
    const response = await answer(page, { ...request, value: '+65 8123 4567' });
    assert.equal(response.ok, true);
    assert.equal(await page.locator('#phone').inputValue(), '+65 8123 4567');
  } finally { await context.close(); }
});

test('stale answer is rejected after the page signature changes', async () => {
  const { context, page } = await application(`<h1>Application</h1><div><label for="notice">Notice period</label><select id="notice" name="questionnaire.notice" required><option value="">Choose</option><option value="30">30 days</option><option value="60">60 days</option></select></div><button data-testid="continue-button">Continue</button>`);
  try {
    const request = await pending(page);
    await page.locator('#notice').evaluate((select) => { select.value = '60'; select.dispatchEvent(new Event('input', { bubbles: true })); });
    const response = await answer(page, { ...request, value: '30' });
    assert.equal(response.ok, false);
    assert.match(response.message, /changed/i);
    await page.waitForFunction(() => window.__messages.filter((message) => message?.phase === 'WAITING_INPUT').length > 1, null, { timeout: 1500 });
    const refreshed = await pending(page);
    assert.notEqual(refreshed.requestId, request.requestId);
    const replay = await answer(page, { ...request, value: '30' });
    assert.equal(replay.ok, false);
    assert.match(replay.message, /current pending question/i);
    assert.equal(await page.locator('#notice').inputValue(), '60');
  } finally { await context.close(); }
});

test('cover letter skip requires an explicit answer and then continues', async () => {
  const { context, page } = await application(`<h1>Application</h1><button data-testid="coverLetter-method-upload">Upload</button><input type="file"><button data-testid="continue-button">Continue</button><output id="clicks">0</output><script>document.querySelector('[data-testid="continue-button"]').onclick=()=>document.querySelector('#clicks').textContent='1'</script>`);
  try {
    const request = await pending(page);
    assert.equal(request.kind, 'coverLetter');
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#clicks').textContent(), '0');
    const response = await answer(page, { ...request, choice: 'skip' });
    assert.equal(response.ok, true);
    await page.waitForFunction(() => document.querySelector('#clicks').textContent === '1', null, { timeout: 1500 });
  } finally { await context.close(); }
});

test('cover letter upload waits for the selected filename to appear before continuing', async () => {
  const { context, page } = await application(`<h1>Application</h1><button data-testid="coverLetter-method-upload">Upload</button><input type="file"><span id="uploaded"></span><script>document.querySelector('input[type=file]').addEventListener('change',e=>document.querySelector('#uploaded').textContent=e.target.files[0].name)</script><button data-testid="continue-button">Continue</button>`);
  try {
    const request = await pending(page);
    await page.locator('input[type="file"]').setInputFiles({ name: 'cover-letter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf') });
    await page.locator('input[type="file"]').evaluate((input) => { input.dataset.roletrackWorkerCover = 'true'; });
    const response = await answer(page, { ...request, choice: 'upload' });
    assert.equal(response.ok, true);
  } finally { await context.close(); }
});

test('cover letter upload stays pending while JobStreet has not confirmed the file', async () => {
  const { context, page } = await application(`<h1>Application</h1><input id="profile-picture" type="file"><button data-testid="coverLetter-method-upload">Upload</button><input id="cover-letter" type="file"><button data-testid="continue-button">Continue</button>`);
  try {
    const request = await pending(page);
    await page.locator('#profile-picture').setInputFiles({ name: 'profile.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('image') });
    const unrelatedUpload = await helperCommand(page, 'checkCoverUpload');
    assert.equal(unrelatedUpload.attached, false);
    assert.equal(unrelatedUpload.complete, false);
    await page.locator('#cover-letter').setInputFiles({ name: 'cover-letter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf') });
    const response = await answer(page, { ...request, choice: 'upload' });
    assert.equal(response.ok, false);
    assert.equal(response.waiting, true);
    assert.equal((await pending(page)).requestId, request.requestId);
    assert.equal(await page.locator('[data-testid="continue-button"]').getAttribute('disabled'), null);
  } finally { await context.close(); }
});

test('Playwright file chooser opened from Cover Letter button selects its associated input', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<input id="profile-picture" type="file"><button data-testid="coverLetter-method-upload" onclick="document.querySelector('#cover-letter').click()">Upload Cover Letter</button><input id="cover-letter" type="file">`);
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('button[data-testid="coverLetter-method-upload"]').click();
    const chooser = await chooserPromise;
    const input = await chooser.element();
    await input.evaluate((el) => { el.dataset.roletrackWorkerCover = 'true'; });
    await chooser.setFiles({ name: 'cover-letter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf') });
    assert.equal(await page.locator('#profile-picture').evaluate((input) => input.files.length), 0);
    assert.equal(await page.locator('#cover-letter').evaluate((input) => input.files[0].name), 'cover-letter.pdf');
  } finally { await page.close(); }
});

test('unrecognized required controls wait for explicit browser takeover', async () => {
  const { context, page } = await application(`<h1>Application</h1><input name="required-answer" required><button data-testid="continue-button">Continue</button>`);
  try {
    const request = await pending(page);
    assert.equal(request.kind, 'unknown');
    assert.equal(request.controlType, 'unknown');
    await page.waitForTimeout(50);
    assert.equal(await page.locator('[data-testid="continue-button"]').isVisible(), true);
  } finally { await context.close(); }
});

test('required non-cover file inputs are surfaced for manual review instead of auto-skipped', async () => {
  const { context, page } = await application(`<h1>Application</h1><label>Profile picture <input id="photo" type="file" required></label><button data-testid="continue-button">Continue</button>`);
  try {
    const request = await pending(page);
    assert.equal(request.kind, 'unknown');
    assert.match(request.prompt, /Profile picture/);
    assert.equal(request.controlType, 'unknown');
  } finally { await context.close(); }
});

test('Review is recorded without clicking Submit', async () => {
  const { context, page } = await application(`<h1>Review</h1><button data-testid="review-submit-application" onclick="this.dataset.clicked='yes'">Submit application</button>`, 'REVIEW_REACHED');
  try {
    await page.waitForFunction(() => window.__messages.some((message) => message?.type === 'roletrack-worker-event' && message.phase === 'REVIEW_REACHED'), null, { timeout: 1500 });
    assert.equal(await page.locator('[data-testid="review-submit-application"]').getAttribute('data-clicked'), null);
    assert.match(await page.locator('[data-qa="msg"]').textContent(), /nothing was submitted/i);
  } finally { await context.close(); }
});

test('browser takeover stays paused until resume explicitly rechecks the page', async () => {
  const { context, page } = await application(`<h1>Application</h1><div><label for="notice">Notice period</label><select id="notice" name="questionnaire.notice"><option value="">Choose</option><option value="30">30 days</option></select></div><button data-testid="continue-button">Continue</button>`);
  try {
    const request = await pending(page);
    await helperCommand(page, 'pauseTask');
    assert.ok(await page.evaluate(() => window.__messages.some((message) => message?.phase === 'WAITING_BROWSER')));
    await page.locator('#notice').selectOption('30');
    await page.waitForTimeout(100);
    assert.equal((await pending(page)).requestId, request.requestId);
    await helperCommand(page, 'resumeTask');
    await page.waitForFunction(() => document.querySelector('[data-testid="continue-button"]') !== null, null, { timeout: 1500 });
    await page.waitForTimeout(100);
    assert.equal((await pending(page)).requestId, request.requestId);
  } finally { await context.close(); }
});

test('stale worker heartbeat pauses automation before Continue is clicked', async () => {
  const { context, page } = await application(`<h1>Application</h1><button data-testid="continue-button" onclick="this.dataset.clicked='yes'">Continue</button>`, 'WAITING_BROWSER', { heartbeatAge: 20000 });
  try {
    assert.match(await page.locator('[data-qa="msg"]').textContent(), /connection lost/i);
    assert.equal(await page.locator('[data-testid="continue-button"]').getAttribute('data-clicked'), null);
  } finally { await context.close(); }
});
