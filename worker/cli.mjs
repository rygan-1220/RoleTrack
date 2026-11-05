import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { TelegramControl } from './telegram.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_DIR = path.join(ROOT, '.roletrack-worker');
const WORKER_CONFIG = path.join(PRIVATE_DIR, 'config.json');
const PROFILE_DIR = path.join(PRIVATE_DIR, 'profile');
const LOG_DIR = path.join(PRIVATE_DIR, 'runs');
const EXTENSION_PATH = ROOT;
const APPLY_RE = /\/job\/\d+\/apply(?:[/?#]|$)/i;
const SG_JOB_RE = /^https:\/\/(?:sg\.jobstreet\.com|(?:www\.)?jobstreet\.com\.sg)\//i;

function applicationUrl(task) {
  if (task.applyUrl && APPLY_RE.test(new URL(task.applyUrl).pathname)) return task.applyUrl;
  if (!task.sourceUrl) throw new Error('Saved task has no JobStreet URL to reopen.');
  const source = new URL(task.sourceUrl);
  const jobId = source.pathname.match(/\/job\/(\d+)/i)?.[1] || source.searchParams.get('jobId');
  if (!jobId) throw new Error('Could not identify the job for the saved task.');
  source.pathname = `/job/${jobId}/apply`;
  source.search = '';
  source.hash = '';
  return source.href;
}

function terminal() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const queued = [];
  let receiver = null;
  rl.on('line', (line) => {
    if (receiver) { const done = receiver; receiver = null; done(line); }
    else queued.push(line);
  });
  return {
    rl,
    ask(prompt) {
      process.stdout.write(prompt);
      if (queued.length) return Promise.resolve(queued.shift());
      return new Promise((resolve) => { receiver = resolve; });
    },
    take() { return queued.shift(); },
    putBack(line) { if (line !== undefined) queued.unshift(line); },
    close() { rl.close(); },
  };
}

function safeLog(taskId, event, details = '') {
  const line = `${new Date().toISOString()} ${taskId || 'setup'} ${event}${details ? ` ${details}` : ''}\n`;
  try { fsSync.mkdirSync(LOG_DIR, { recursive: true }); fsSync.appendFileSync(path.join(LOG_DIR, `${taskId || 'setup'}.log`), line, 'utf8'); } catch {}
  process.stdout.write(`[${event}]${details ? ` ${details}` : ''}\n`);
}

async function readWorkerConfig() {
  try { return JSON.parse(await fs.readFile(WORKER_CONFIG, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

async function saveCoverLetterDirectory(directory) {
  const config = await readWorkerConfig();
  config.coverLetterDirectory = directory;
  await fs.mkdir(PRIVATE_DIR, { recursive: true });
  await fs.writeFile(WORKER_CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function configureTelegram(ui) {
  const token = (await ui.ask('Telegram Bot Token (blank keeps current or disables): ')).trim();
  const config = await readWorkerConfig();
  if (!token && !config.telegram?.token) return;
  if (token) {
    const test = new TelegramControl(token, { userId: '0', chatId: '0' });
    await test.api('getMe');
    config.telegram = { token, offset: 0 };
  }
  const active = new TelegramControl(config.telegram.token, { userId: '0', chatId: '0' }, { offset: config.telegram.offset || 0, onOffset: (offset) => { config.telegram.offset = offset; } });
  const me = await active.api('getMe');
  const nonce = crypto.randomBytes(3).toString('hex').toUpperCase();
  console.log(`Open a private chat with @${me.username}, press Start, and send: bind ${nonce}`);
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const updates = await active.api('getUpdates', { offset: config.telegram.offset || 0, timeout: 25, allowed_updates: ['message'] });
    for (const update of updates) {
      config.telegram.offset = update.update_id + 1;
      const msg = update.message;
      if (msg?.chat?.type === 'private' && msg.text?.trim() === `bind ${nonce}`) {
        config.telegram.userId = String(msg.from.id);
        config.telegram.chatId = String(msg.chat.id);
        await active.api('sendMessage', { chat_id: msg.chat.id, text: 'RoleTrack worker is bound to this private chat.' });
        await fs.mkdir(PRIVATE_DIR, { recursive: true });
        await fs.writeFile(WORKER_CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        console.log('Telegram private chat bound and saved locally.');
        return;
      }
    }
  }
  throw new Error('Telegram binding timed out. Run worker:setup again to bind the private chat.');
}

async function coverLetterFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^COVERLETTER_.+\.(?:pdf|docx?|rtf|txt|odt)$/i.test(entry.name))
    .map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

async function launch() {
  await fs.mkdir(PROFILE_DIR, { recursive: true });
  await fs.mkdir(LOG_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30000 });
  const extensionId = new URL(worker.url()).host;
  const bridge = await context.newPage();
  const bridgeUrl = `chrome-extension://${extensionId}/worker/bridge.html`;
  await bridge.goto(bridgeUrl);
  const expectedVersion = JSON.parse(await fs.readFile(path.join(ROOT, 'manifest.json'), 'utf8')).version;
  let loadedVersion = await bridge.evaluate(() => chrome.runtime.getManifest().version).catch(() => '');
  let protocol = await extensionCommand(bridge, 'getWorkerProtocol').catch(() => null);
  if (loadedVersion !== expectedVersion || protocol?.version !== expectedVersion || protocol?.supportsResume !== true || protocol?.supportsPreparedJob !== true || protocol?.supportsDuplicateChoice !== true || protocol?.supportsWorkerDryRunPreference !== true) {
    console.log(`[EXTENSION] Reloading RoleTrack to version ${expectedVersion}...`);
    await bridge.goto('chrome://extensions/');
    const reloaded = await bridge.evaluate(async () => {
      const allElements = (root) => {
        const found = [];
        for (const element of root.querySelectorAll('*')) {
          found.push(element);
          if (element.shadowRoot) found.push(...allElements(element.shadowRoot));
        }
        return found;
      };
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const item = allElements(document).find((element) => {
          if (element.localName !== 'extensions-item' || !element.shadowRoot) return false;
          const name = element.shadowRoot.querySelector('#name')?.textContent?.trim();
          return name === 'RoleTrack';
        });
        const reloadButton = item?.shadowRoot?.querySelector('#dev-reload-button');
        if (reloadButton && !reloadButton.disabled) {
          reloadButton.click();
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 125));
      }
      return false;
    });
    if (!reloaded) throw new Error('Could not find RoleTrack’s Reload button on chrome://extensions. Enable Developer mode and retry.');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await bridge.goto(bridgeUrl);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      loadedVersion = await bridge.evaluate(() => chrome.runtime.getManifest().version).catch(() => '');
      protocol = await extensionCommand(bridge, 'getWorkerProtocol').catch(() => null);
      if (loadedVersion === expectedVersion && protocol?.version === expectedVersion && protocol?.supportsResume === true && protocol?.supportsPreparedJob === true && protocol?.supportsDuplicateChoice === true && protocol?.supportsWorkerDryRunPreference === true) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (loadedVersion !== expectedVersion || protocol?.version !== expectedVersion || protocol?.supportsResume !== true || protocol?.supportsPreparedJob !== true || protocol?.supportsDuplicateChoice !== true || protocol?.supportsWorkerDryRunPreference !== true) {
    throw new Error(`RoleTrack extension did not reload to version ${expectedVersion}. Open chrome://extensions, reload RoleTrack, and retry.`);
  }
  console.log(`[EXTENSION] RoleTrack ${loadedVersion} ready.`);
  return { context, worker, bridge };
}

async function extensionCommand(bridge, command, args = {}) {
  const response = await bridge.evaluate(async ({ command, args }) => {
    return chrome.runtime.sendMessage({ type: 'roletrack-worker-command', command, args });
  }, { command, args });
  if (response?.ok === false && !response.waiting) throw new Error(response.error || response.message || `${command} failed`);
  return response;
}

async function sendAnswer(bridge, pending, answer) {
  try {
    await extensionCommand(bridge, 'answerQuestion', { ...pending, ...answer });
  } catch (error) {
    console.log(`${error?.message || error} The page will be checked again before another answer is accepted.`);
  }
}

async function setup() {
  const ui = terminal();
  let context;
  try {
    const launched = await launch();
    ({ context } = launched);
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://sg.jobstreet.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    console.log('\nRoleTrack worker setup browser is open with its dedicated profile.');
    console.log('Sign in to JobStreet if needed. Open the RoleTrack side panel and save your test Sheet settings.');
    let sheetValidated = false;
    while (true) {
      const response = (await ui.ask('Press Enter to validate the saved test Sheet, or type exit to close: ')).trim().toLowerCase();
      if (response === 'exit' || response === 'quit') break;
      try {
        await extensionCommand(launched.bridge, 'testSheet');
        console.log('Test Sheet connection succeeded.');
        sheetValidated = true;
        break;
      } catch (error) { console.log(`${error?.message || error} Configure the test Sheet in the side panel, then try again.`); }
    }
    if (sheetValidated) {
      const config = await readWorkerConfig();
      const existingDirectory = config.coverLetterDirectory || '';
      while (true) {
        const prompt = existingDirectory
          ? `Cover letter directory [Enter keeps ${existingDirectory}]: `
          : 'Cover letter directory (files named COVERLETTER_*): ';
        const answer = (await ui.ask(prompt)).trim().replace(/^"|"$/g, '');
        if (!answer && existingDirectory) break;
        if (!answer) { console.log('Enter a directory path.'); continue; }
        const directory = path.resolve(answer);
        try {
          const stat = await fs.stat(directory);
          if (!stat.isDirectory()) throw new Error('That path is not a directory.');
          await saveCoverLetterDirectory(directory);
          console.log(`Cover letter directory saved: ${directory}`);
          break;
        } catch (error) { console.log(`${error?.message || error} Enter a valid directory path.`); }
      }
      await configureTelegram(ui);
    }
    console.log('Profile and extension settings will persist in .roletrack-worker/profile.');
  } finally {
    ui.close();
    if (context) await context.close();
  }
}

async function resetTask() {
  const ui = terminal();
  let context;
  try {
    const launched = await launch();
    ({ context } = launched);
    const task = await extensionCommand(launched.bridge, 'getTask');
    if (task?.taskId && !['COMPLETED', 'FAILED', 'CANCELLED', 'REVIEW_REACHED'].includes(task.phase)) {
      const confirmation = (await ui.ask(`Task ${task.taskId} is ${task.phase}. Type reset to abandon it: `)).trim().toLowerCase();
      if (confirmation !== 'reset') { console.log('Task state was left unchanged.'); return; }
      await extensionCommand(launched.bridge, 'cancelTask');
    }
    await extensionCommand(launched.bridge, 'resetTask');
    console.log('Worker task state cleared. No unfinished task was replayed.');
  } finally { ui.close(); if (context) await context.close(); }
}

async function run() {
  const resumeMode = process.argv.includes('--resume');
  const telegramMode = process.argv.includes('--telegram');
  const idx = process.argv.indexOf('--url');
  let url = idx >= 0 ? process.argv[idx + 1] : '';
  if (!resumeMode && url && !SG_JOB_RE.test(url)) throw new Error('Usage: npm run worker:run -- --url "https://sg.jobstreet.com/job/..." (or --resume for the saved task)');

  const ui = terminal();
  let context;
  let heartbeatTimer;
  let taskId = crypto.randomUUID();
  let applyPage = null;
  try {
    let telegram;
    if (telegramMode) {
      const config = await readWorkerConfig();
      if (!config.telegram?.token || !config.telegram?.userId || !config.telegram?.chatId) throw new Error('Configure and bind Telegram with npm run worker:setup first.');
      telegram = new TelegramControl(config.telegram.token, config.telegram, { offset: config.telegram.offset || 0, onOffset: (offset) => { config.telegram.offset = offset; fs.writeFile(WORKER_CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8').catch(() => {}); } });
      await telegram.start();
      ui.ask = async (prompt = '') => {
        if (prompt) await telegram.send(prompt);
        while (true) {
          const incoming = await telegram.next();
          const value = incoming.text.trim();
          if (value === '/status') { const current = await extensionCommand(bridge, 'getTask'); await telegram.send(`Task ${current?.taskId || 'not started'}: ${current?.phase || 'idle'}`); continue; }
          if (value === '/pause') { await extensionCommand(bridge, 'pauseTask').catch(() => {}); await telegram.send('Paused. Complete any browser verification on the worker computer, then send /resume.'); continue; }
          if (value === '/resume') { await extensionCommand(bridge, 'resumeTask').catch(async () => telegram.send('Could not resume yet. Check the JobStreet application tab on the worker computer.')); continue; }
          if (value === '/cancel') { await extensionCommand(bridge, 'cancelTask').catch(() => {}); return 'cancel'; }
          return value;
        }
      };
      ui.take = () => telegram.take()?.text;
      ui.putBack = (line) => telegram.putBack(line === undefined ? undefined : { type: 'text', text: line });
      ui.close = () => { telegram.stop(); };
      await telegram.send(`RoleTrack worker online. ${resumeMode ? 'Resuming the saved task.' : 'Send /apply <JobStreet URL> to start a task.'}`);
      if (!resumeMode && !url) {
        while (!url) {
          const incoming = (await telegram.next()).text.trim();
          if (incoming.startsWith('/apply ')) url = incoming.slice(7).trim();
          else if (incoming === '/status') await telegram.send('No task has started yet.');
          else await telegram.send('Send /apply <JobStreet URL> to start a task.');
          if (url && !SG_JOB_RE.test(url)) { await telegram.send('That URL is not a supported Singapore JobStreet link.'); url = ''; }
        }
      }
    }
    const launched = await launch();
    ({ context } = launched);
    const { bridge } = launched;
    const setupState = await extensionCommand(bridge, 'getSetupStatus');
    if (!setupState?.configured) throw new Error('Set up and test your Sheet first with npm run worker:setup.');
    if (telegram && !setupState.dryRun) throw new Error('Telegram mode always stops at Review. Turn on Settings → Dry run in the RoleTrack side panel, then restart the worker.');
    console.log(`[SETTINGS] Dry run is ${setupState.dryRun ? 'ON (stops at Review)' : 'OFF (will submit after the configured countdown)'}.`);
    if (telegram) await telegram.send(`Worker connected. Dry run is ${setupState.dryRun ? 'ON; the task stops at Review.' : 'OFF; submission may occur after the configured countdown.'}`);
    let page;
    let started;
    let duplicateSkipped = false;
    if (resumeMode) {
      let task = await extensionCommand(bridge, 'getTask');
      if (!task?.taskId) throw new Error('There is no saved worker task to resume.');
      if (task.phase === 'SYNCING' || ['FAILED', 'CANCELLED', 'COMPLETED'].includes(task.phase)) {
        throw new Error(`Saved task is ${task.phase}. It cannot safely resume. Inspect the Sheet, then use npm run worker:reset before starting again.`);
      }
      if (task.phase === 'WAITING_INPUT' && task.pending?.kind === 'duplicate') {
        const prompt = `${task.pending.prompt}\nExisting Sheet row: ${task.pending.existingRow || 'unknown'}`;
        let choice;
        if (telegram) {
          choice = await telegram.choose(prompt, [
            { label: 'Continue (skip sync)', value: 'continue' }, { label: 'End', value: 'end' },
          ]);
          if (!choice) throw new Error('No valid Telegram duplicate choice was received. Restart with --resume to choose again.');
        } else {
          while (!choice) {
            const answer = (await ui.ask(`${prompt}\nType continue or end: `)).trim().toLowerCase();
            if (['continue', 'c', 'skip'].includes(answer)) choice = 'continue';
            else if (['end', 'cancel', 'exit', 'quit'].includes(answer)) choice = 'end';
          }
        }
        const resolved = await extensionCommand(bridge, 'resolveDuplicate', { taskId: task.taskId, choice });
        if (choice === 'end') {
          if (telegram) await telegram.send('Application ended. No duplicate row was added.');
          console.log('Application ended. No duplicate row was added.');
          return;
        }
        task = resolved.task;
      }
      taskId = task.taskId;
      const targetUrl = applicationUrl(task);
      page = context.pages().find((item) => APPLY_RE.test(new URL(item.url()).pathname)) || await context.newPage();
      console.log('Reopening the saved JobStreet application. The Sheet will not be synced again.');
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      applyPage = page;
      if (task.phase !== 'REVIEW_REACHED') {
        const deadline = Date.now() + 60000;
        let attached = false;
        let lastAttachError = '';
        let reportedAttachError = false;
        let attachAttempts = 0;
        console.log('Waiting for the RoleTrack helper to reconnect to the application tab...');
        while (Date.now() < deadline) {
          attachAttempts++;
          const result = await extensionCommand(bridge, 'attachTask', { taskId, url: page.url() }).catch((error) => {
            lastAttachError = error?.message || String(error);
            if (!reportedAttachError) { console.log(`Waiting for the page helper (${lastAttachError}).`); reportedAttachError = true; }
            return null;
          });
          if (result?.taskId === taskId || result?.ok) { attached = true; break; }
          if (attachAttempts >= 10) {
            console.log('The helper is still unavailable. Pausing for browser takeover so you can check sign-in or the application page.');
            await extensionCommand(bridge, 'pauseTask');
            attached = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        if (!attached) throw new Error(`RoleTrack could not reconnect to the saved application. ${lastAttachError || 'The helper did not respond within 60 seconds.'}`);
      }
      const reopened = await extensionCommand(bridge, 'getTask');
      if (!['APPLYING', 'WAITING_INPUT', 'WAITING_BROWSER', 'REVIEW_REACHED'].includes(reopened?.phase)) {
        throw new Error('Could not reconnect to the saved JobStreet application within 60 seconds.');
      }
      started = { task: reopened };
      console.log(`Reattached to saved task ${taskId}; Sheet sync will not be repeated.`);
    } else {
      const prior = await extensionCommand(bridge, 'getTask');
      if (prior?.taskId && !['COMPLETED', 'FAILED', 'CANCELLED', 'REVIEW_REACHED'].includes(prior.phase)) {
        throw new Error(`Saved task ${prior.taskId} is ${prior.phase}. Use npm run worker:resume to continue without syncing again, or npm run worker:reset to abandon it.`);
      }
      await extensionCommand(bridge, 'resetTask');
      page = context.pages()[0] || await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const ready = await page.evaluate(() => document.readyState !== 'loading' && !!document.body?.innerText?.trim()).catch(() => false);
        if (ready) {
          const helper = await extensionCommand(bridge, 'checkJobPage', { url }).catch(() => null);
          if (helper?.ready && helper.quickApplyAvailable) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (Date.now() >= deadline) throw new Error('Job page, RoleTrack helper, and a Quick Apply action did not become ready within 60 seconds.');
      const prepared = await extensionCommand(bridge, 'prepareJob', { taskId, url });
      const info = prepared.task?.jobInfo;
      if (info) {
        console.log('\n[JOB_INFO]');
        for (const [label, value] of [['Company', info.company], ['Role', info.role], ['Location', info.location], ['Salary', info.salary], ['Employment type', info.employmentType]]) {
          if (value) console.log(`  ${label}: ${value}`);
        }
      }
      safeLog(taskId, 'SYNCING', 'Writing job details to the Sheet.');
      started = await extensionCommand(bridge, 'syncAndStartJob', { taskId, job: prepared.job });
      if (started.waiting && started.duplicate) {
        const duplicate = started.task?.pending;
        console.log(`\n${duplicate?.prompt || 'This job is already in the Sheet.'}`);
        if (duplicate?.existingRow) console.log(`Existing Sheet row: ${duplicate.existingRow}`);
        if (telegram) {
          const choice = await telegram.choose(`${duplicate?.prompt || 'This job is already in the Sheet.'}\nExisting row: ${duplicate?.existingRow || 'unknown'}`, [
            { label: 'Continue (skip sync)', value: 'continue', key: `duplicate:${taskId}` }, { label: 'End', value: 'end', key: `duplicate:${taskId}` },
          ]);
          const resolved = await extensionCommand(bridge, 'resolveDuplicate', { taskId, choice });
          if (choice === 'end') { await telegram.send('Application ended. No duplicate row was added.'); return; }
          started = resolved; duplicateSkipped = true;
        }
        if (!telegram) {
          let choice = '';
          while (!choice) {
            const answer = (await ui.ask('Type continue to skip sync and continue to Quick Apply, or end to stop: ')).trim().toLowerCase();
            if (['continue', 'c', 'skip'].includes(answer)) choice = 'continue';
            else if (['end', 'cancel', 'exit', 'quit'].includes(answer)) choice = 'end';
            else console.log('Enter continue or end.');
          }
          const resolved = await extensionCommand(bridge, 'resolveDuplicate', { taskId, choice });
          if (choice === 'end') {
            safeLog(taskId, 'CANCELLED', 'User ended the application after a duplicate was found; no Sheet row was added.');
            console.log('Application ended. No duplicate row was added and Quick Apply was not opened.');
            return;
          }
          started = resolved;
        }
        duplicateSkipped = true;
        safeLog(taskId, 'DUPLICATE_SKIPPED', 'Continuing to Quick Apply without syncing a Sheet row.');
      }
    }
    heartbeatTimer = setInterval(() => { extensionCommand(bridge, 'heartbeat', { taskId }).catch(() => {}); }, 2000);
    heartbeatTimer.unref?.();
    if (resumeMode) safeLog(taskId, 'REATTACHED', 'Sheet sync was not repeated.');
    else if (!duplicateSkipped) {
      safeLog(taskId, 'SYNCED', started.task?.sheetRow ? `sheet-row=${started.task.sheetRow}` : 'sheet sync succeeded');
    }
    console.log('Worker task started. Use pause to take over the browser; resume returns to automation.');
    if (telegram) await telegram.send(`Task ${taskId} started. Use /status, /pause, /resume, or /cancel.`);

    let lastPhase = '';
    let takeoverNoticeSent = false;
    while (true) {
      const inputLine = ui.take();
      const command = inputLine?.trim().toLowerCase();
      if (command === '/status') {
        const status = await extensionCommand(bridge, 'getTask');
        await telegram?.send(`Task ${status?.taskId || taskId}: ${status?.phase || 'unknown'}`);
      } else if (command === '/pause' || command === 'pause') {
        await extensionCommand(bridge, 'pauseTask');
        safeLog(taskId, 'WAITING_BROWSER', 'Browser takeover requested.');
      } else if (command === '/resume' || command === 'resume') {
        try {
          const currentPage = context.pages().find((p) => APPLY_RE.test(new URL(p.url()).pathname));
          if (!currentPage) throw new Error('Return to the JobStreet application tab before resuming.');
          applyPage = currentPage;
          const currentTask = await extensionCommand(bridge, 'getTask');
          if (currentTask?.phase === 'WAITING_BROWSER') {
            await extensionCommand(bridge, 'attachTask', { taskId, url: currentPage.url(), paused: true });
          }
          await extensionCommand(bridge, 'resumeTask');
          safeLog(taskId, 'APPLYING', 'Browser rechecked after takeover.');
        } catch (error) {
          console.log(`Could not reconnect yet: ${error?.message || error} Finish sign-in and return to the JobStreet application, then type resume again.`);
          continue;
        }
      } else if (command === '/cancel') {
        await extensionCommand(bridge, 'cancelTask');
      } else if (command === 'exit' || command === 'quit') {
        await extensionCommand(bridge, 'pauseTask').catch(() => {});
        safeLog(taskId, 'WAITING_BROWSER', 'Worker stopped by user.');
        break;
      } else if (inputLine !== undefined) ui.putBack(inputLine);

      let task = await extensionCommand(bridge, 'getTask');
      if (!task) throw new Error('Worker task state is missing; no task was replayed.');
      if (task.phase !== lastPhase) {
        safeLog(taskId, task.phase);
        if (telegram && ['WAITING_BROWSER', 'REVIEW_REACHED', 'FAILED', 'CANCELLED'].includes(task.phase)) await telegram.send(`Task ${taskId}: ${task.phase}${task.phase === 'WAITING_BROWSER' ? '. Complete any CAPTCHA or login check in the worker browser, then send /resume.' : task.phase === 'REVIEW_REACHED' ? '. Review reached; no submission was made.' : '.'}`);
        lastPhase = task.phase;
        if (task.phase !== 'WAITING_BROWSER') takeoverNoticeSent = false;
      }
      const pages = context.pages();
      applyPage = pages.find((p) => APPLY_RE.test(new URL(p.url()).pathname)) || applyPage;

      if (task.phase === 'WAITING_INPUT' && task.pending) {
        const pending = task.pending;
        if (telegram) await telegram.send(`${pending.prompt}\n${pending.controlType || ''}${pending.required ? ' (required)' : ''}${pending.currentAnswer ? `\nCurrent: ${pending.currentAnswer}` : ''}`);
        console.log(`\n${pending.prompt}\nControl: ${pending.controlType}${pending.required ? ' (required)' : ''}`);
        if (pending.currentAnswer) console.log(`Current answer: ${pending.currentAnswer}`);
        if (pending.kind === 'coverLetter') {
          const config = await readWorkerConfig();
          let files = [];
          if (config.coverLetterDirectory) {
            try { files = await coverLetterFiles(config.coverLetterDirectory); }
            catch (error) { console.log(`Could not read cover letter directory: ${error?.message || error}`); }
          }
          files.forEach((file, i) => console.log(`${i + 1}. ${file.name}`));
          if (!files.length) console.log('No COVERLETTER_* files found in the configured directory.');
          let answer;
          if (telegram) {
            answer = files.length
              ? await telegram.choose('Choose a Cover Letter or skip:', [...files.map((file, i) => ({ label: file.name, value: `file:${i}`, key: `${taskId}:${pending.requestId}` })), { label: 'Skip', value: 'skip', key: `${taskId}:${pending.requestId}` }])
              : await telegram.choose('No COVERLETTER_* files found in the configured directory.', [{ label: 'Skip', value: 'skip', key: `${taskId}:${pending.requestId}` }]);
            if (typeof answer !== 'string' || !answer) {
              await telegram.send('I did not receive a valid button choice. Please choose a Cover Letter or Skip again.');
              continue;
            }
            if (answer.startsWith('file:')) answer = String(Number(answer.slice(5)) + 1);
          } else answer = (await ui.ask(files.length ? 'Enter file number, or type skip: ' : 'Type skip (or fix the cover letter directory in worker setup): ')).trim();
          if (answer.toLowerCase() === 'pause') { await extensionCommand(bridge, 'pauseTask'); continue; }
          if (['exit', 'quit', 'cancel', '/cancel'].includes(answer.toLowerCase())) { await extensionCommand(bridge, 'cancelTask'); throw new Error('Task cancelled by user.'); }
          if (answer.toLowerCase() === 'skip') {
            await sendAnswer(bridge, pending, { choice: 'skip' });
          } else {
            try {
              const choice = Number(answer);
              if (!Number.isInteger(choice) || choice < 1 || choice > files.length) throw new Error('Enter one of the listed file numbers, or type skip.');
              const coverPath = files[choice - 1].path;
              await fs.access(coverPath);
              applyPage = pages.find((p) => APPLY_RE.test(new URL(p.url()).pathname)) || applyPage;
              if (!applyPage) throw new Error('Application tab is unavailable for cover letter upload.');
              const chooserPromise = applyPage.waitForEvent('filechooser', { timeout: 10000 });
              await applyPage.locator('button[data-testid="coverLetter-method-upload"]').click();
              const chooser = await chooserPromise;
              const coverInput = await chooser.element();
              await coverInput.evaluate((input) => { input.dataset.roletrackWorkerCover = 'true'; });
              await chooser.setFiles(coverPath);
              const deadline = Date.now() + 60000;
              let complete = false;
              let skipped = false;
              console.log('[UPLOADING] Upload is processing. Type skip to skip or exit to cancel while the worker checks its status.');
              while (!complete && Date.now() < deadline) {
                const status = await extensionCommand(bridge, 'checkCoverUpload').catch(() => null);
                complete = status?.complete === true;
                if (complete) break;
                const terminalInput = ui.take()?.trim().toLowerCase();
                if (terminalInput === 'skip') {
                  await sendAnswer(bridge, pending, { choice: 'skip' });
                  skipped = true;
                  break;
                }
                if (terminalInput === 'pause') {
                  await extensionCommand(bridge, 'pauseTask');
                  skipped = true;
                  break;
                }
                if (['exit', 'quit', '/cancel', 'cancel'].includes(terminalInput)) {
                  await extensionCommand(bridge, 'cancelTask');
                  throw new Error('Task cancelled by user.');
                }
                await new Promise((resolve) => setTimeout(resolve, 300));
              }
              if (skipped) continue;
              if (!complete) { console.log('Cover Letter upload was not confirmed. Choose a file number again or type skip.'); continue; }
              await sendAnswer(bridge, pending, { choice: 'upload' });
            } catch (error) { console.log(`${error?.message || error} Try another file or type skip.`); continue; }
          }
          continue;
        }
        if (pending.kind === 'unknown') {
          console.log('RoleTrack cannot identify this required control. It will not choose an answer. Take over the browser, complete it, then resume.');
          await extensionCommand(bridge, 'pauseTask');
          continue;
        }
        let answer;
        if (pending.controlType === 'radio' || pending.controlType === 'select') {
          if (telegram) {
            const enabled = (pending.options || []).filter((option) => !option.disabled);
            const value = await telegram.choose('Choose an answer:', enabled.map((option) => ({ label: option.text, value: `option:${option.id}`, key: `${taskId}:${pending.questionId}:${pending.requestId}` })));
            const option = enabled.find((item) => `option:${item.id}` === value);
            if (option) await sendAnswer(bridge, pending, { optionId: option.id, value: option.value });
            continue;
          }
          pending.options.forEach((option, i) => console.log(`${i + 1}. ${option.text}${option.disabled ? ' [disabled]' : ''}${option.value === pending.currentAnswer ? ' [current]' : ''}`));
          answer = (await ui.ask('Enter option number (or cancel): ')).trim();
          if (answer.toLowerCase() === 'pause') { await extensionCommand(bridge, 'pauseTask'); continue; }
          if (answer.toLowerCase() === 'cancel' || answer.toLowerCase() === 'exit' || answer.toLowerCase() === 'quit') { await extensionCommand(bridge, 'cancelTask'); throw new Error('Task cancelled by user while awaiting an answer.'); }
          const index = Number(answer) - 1;
          const option = pending.options[index];
          if (!option || option.disabled) { console.log('Choose an enabled option number.'); continue; }
          await sendAnswer(bridge, pending, { optionId: option.id, value: option.value });
        } else {
          answer = await ui.ask('Enter answer (or type cancel): ');
          if (answer.trim().toLowerCase() === 'pause') { await extensionCommand(bridge, 'pauseTask'); continue; }
          if (['cancel', 'exit', 'quit'].includes(answer.trim().toLowerCase())) { await extensionCommand(bridge, 'cancelTask'); throw new Error('Task cancelled by user while awaiting an answer.'); }
          await sendAnswer(bridge, pending, { value: answer });
        }
        continue;
      }

      if (task.phase === 'WAITING_BROWSER') {
        if (!takeoverNoticeSent) {
          if (telegram) await telegram.send('Browser takeover is active. Complete verification in the worker browser, then send /resume.');
          else console.log('Browser takeover is active. Complete the step in the browser, then type resume.');
          takeoverNoticeSent = true;
        }
        if (telegram) { await new Promise((resolve) => setTimeout(resolve, 700)); continue; }
        const takeoverInput = (await ui.ask('Command (resume / exit): ')).trim().toLowerCase();
        if (takeoverInput === 'resume' || takeoverInput === 'exit' || takeoverInput === 'quit') {
          ui.putBack(takeoverInput);
        } else {
          console.log('Type resume to return to automation, or exit to stop the worker.');
        }
        continue;
      }
      if (task.phase === 'REVIEW_REACHED') {
        safeLog(taskId, 'REVIEW_REACHED', 'No submission attempted.');
        console.log('\nReview reached. The browser will remain open. Do not click Submit unless you intend to submit the application.');
        if (telegram) await telegram.send('Review reached. The worker will not submit. The browser remains open on the worker computer.');
        if (telegram) {
          while (true) {
            const command = (await telegram.next()).text.trim().toLowerCase();
            if (command === '/cancel' || command === '/exit') break;
            if (command === '/status') await telegram.send(`Task ${taskId}: REVIEW_REACHED. No submission was made.`);
            else await telegram.send('Task is at Review. Send /status or /cancel to close the worker.');
          }
          break;
        }
        while (true) {
          const finalInput = (await ui.ask('Type exit to close the browser; press Enter to keep it open: ')).trim().toLowerCase();
          if (finalInput === 'exit' || finalInput === 'quit') break;
          console.log('Browser is still open at Review. Type exit when you are finished.');
        }
        break;
      }
      if (task.phase === 'COMPLETED') {
        safeLog(taskId, 'COMPLETED', 'Submit button was clicked; verify JobStreet confirmation in the browser.');
        console.log('\nSubmit was clicked. Check JobStreet for its confirmation. The browser will remain open until you finish.');
        while (true) {
          const finalInput = (await ui.ask('Type exit when finished; press Enter to keep the browser open: ')).trim().toLowerCase();
          if (finalInput === 'exit' || finalInput === 'quit') break;
          console.log('Browser is still open. Type exit when you are finished.');
        }
        break;
      }
      if (task.phase === 'FAILED' || task.phase === 'CANCELLED') throw new Error(task.error || `Task ended in ${task.phase}.`);

      if (applyPage) {
        const pageState = await applyPage.evaluate(() => ({
          url: location.href,
          text: (document.body?.innerText || '').slice(0, 5000),
          continueButton: !!document.querySelector('button[data-testid="continue-button"]'),
          submitButton: !!document.querySelector('button[data-testid="review-submit-application"]'),
        })).catch(() => null);
        if (pageState && /captcha|verify (?:that )?you are human|unusual traffic|sign in to continue|log in to continue/i.test(`${pageState.url}\n${pageState.text}`)) {
          await extensionCommand(bridge, 'pauseTask');
          safeLog(taskId, 'WAITING_BROWSER', 'Possible CAPTCHA or login challenge detected.');
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  } catch (error) {
    safeLog(taskId, 'FAILED', 'Worker command failed; details shown in terminal.');
    if (context) {
      const page = applyPage || context.pages()[0];
      if (page) {
        await fs.mkdir(LOG_DIR, { recursive: true });
        await page.screenshot({ path: path.join(LOG_DIR, `${taskId}-failure.png`), fullPage: true }).catch(() => {});
      }
    }
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    ui.close();
    if (context) await context.close();
  }
}

const command = process.argv[2];
if (command === 'setup') await setup();
else if (command === 'run') await run();
else if (command === 'resume') { process.argv.push('--resume'); await run(); }
else if (command === 'reset') await resetTask();
else throw new Error('Use `setup`, `run -- --url <job URL>`, `resume`, or `reset`.');
