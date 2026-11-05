// Jobstreet Quick Apply Helper — content script (v0.2.0)
//
// Job page / side panel : Sync + Quick Apply or Alt+A -> opens the Quick Apply tab.
//                         Optional auto start: stay on a Quick Apply job for 3s -> opens it.
// Apply tab             : walks the steps. Clicks Continue when everything is answered,
//                         pauses on new questions, opens the cover-letter file dialog,
//                         continues once a cover letter is attached, and can submit at Review
//                         after the configured countdown — only when DRY RUN is off.
// DRY RUN (in RoleTrack Settings, ON by default): everything runs as normal EXCEPT the final
// "Submit application" click, which is never made. Turn it off to allow submitting.

(() => {
  'use strict';
  if (window.__qaLoaded) return;
  window.__qaLoaded = true;

  const TEST = !!window.__QA_TEST; // shrinks delays in the sandbox test
  const ARM_TTL = 2 * 60 * 1000;
  const MAX_STEPS = 12;
  const AUTO_DWELL = TEST ? 30 : 3000;
  const DEFAULT_SUBMIT_COUNTDOWN = 5;
  const SUBMIT_COUNTDOWNS = [0, 3, 5, 10];
  const SEC = TEST ? 10 : 1000;

  // All selectors live here. If Jobstreet changes its markup, edit this block only.
  const SEL = {
    applyBtn: 'a[data-automation="job-detail-apply"]',
    continueBtn: 'button[data-testid="continue-button"]',
    coverUploadBtn: 'button[data-testid="coverLetter-method-upload"]',
    submitBtn: 'button[data-testid="review-submit-application"]',
    fileInput: 'input[type="file"]',
    radioGroup: 'fieldset[role="radiogroup"]',
    select: 'select[name^="questionnaire."]',
    textField:
      'input[name^="questionnaire."]:not([type="radio"]):not([type="checkbox"]), textarea[name^="questionnaire."]',
    invalid: '[aria-invalid="true"]',
  };
  const FILE_RE = /[^\s/\\<>:"|?*]+\.(?:pdf|docx?|rtf|txt|odt)\b/gi;
  const ADDED_RE = /Added\s+(?:less than a minute|\d+\s*minutes?)\s+ago/i; // shown under a freshly uploaded file

  // Chrome rejects pending extension API calls in an already-open page when the extension is
  // reloaded or updated. Resolve those calls safely so timers and event handlers don't emit
  // unhandled "Extension context invalidated" promise errors.
  const localStore = chrome.storage.local;
  const store = {
    async get(...args) {
      try { return await localStore.get(...args); } catch (_) { return {}; }
    },
    async set(...args) {
      try { return await localStore.set(...args); } catch (_) { return undefined; }
    },
    async remove(...args) {
      try { return await localStore.remove(...args); } catch (_) { return undefined; }
    },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => (TEST ? 5 : a + Math.random() * (b - a));

  let busy = false;
  let stopped = false;
  let resumeRequested = false;
  let stepsDone = 0;
  let flowStarted = false;
  let box, msgEl, dryStatusEl, confirmBtn, stopBtn, hl;
  let countdownRemaining = null;
  let dryStatusRevision = 0;
  let workerMode = false;
  let workerPaused = false;
  let workerPending = null;
  const workerTaskKey = 'roleTrackWorkerTask';
  const workerHeartbeatKey = 'roleTrackWorkerHeartbeat';

  let watchedId = null;
  let autoTimer = null;

  // cover-letter step state
  let coverBaseline = null; // filenames visible when we first saw the Upload button
  let coverSkipped = false;
  let manualCoverStepSig = null;
  let manualCoverContinueConfirmed = false;
  let uploadTried = false;
  let gestureHandler = null;

  /* ---------------- overlay ---------------- */

  function ensureOverlay() {
    if (box) {
      if (!box.isConnected) document.body.appendChild(box); // page re-rendered and dropped it
      return;
    }
    box = document.createElement('div');
    box.setAttribute('data-qa', 'overlay');
    const header = document.createElement('div');
    header.setAttribute('data-qa', 'header');
    const title = document.createElement('strong');
    title.textContent = 'Quick Apply';
    dryStatusEl = document.createElement('span');
    dryStatusEl.setAttribute('data-qa', 'dry-status');
    header.append(title, dryStatusEl);

    msgEl = document.createElement('div');
    msgEl.setAttribute('data-qa', 'msg');
    msgEl.setAttribute('role', 'status');
    msgEl.setAttribute('aria-live', 'polite');

    confirmBtn = document.createElement('button');
    confirmBtn.setAttribute('data-qa', 'confirm');
    confirmBtn.hidden = true;
    confirmBtn.onclick = onConfirm;

    stopBtn = document.createElement('button');
    stopBtn.setAttribute('data-qa', 'stop');
    stopBtn.dataset.action = 'stop';
    stopBtn.textContent = 'Stop application';
    stopBtn.hidden = true;
    stopBtn.onclick = () => stop('Stopped.');

    box.append(header, msgEl, confirmBtn, stopBtn);
    document.body.appendChild(box);
    refreshDryStatus();
  }

  function setStatus(msg, showConfirm = false, confirmLabel = 'Continue') {
    ensureOverlay();
    msgEl.textContent = msg;
    confirmBtn.textContent = confirmLabel;
    confirmBtn.hidden = !showConfirm;
    stopBtn.hidden = !isApplyPage() || workerMode;
    stopBtn.disabled = false;
    stopBtn.textContent = stopped ? 'Resume application' : 'Stop application';
    stopBtn.dataset.action = stopped ? 'resume' : 'stop';
    stopBtn.onclick = () => stopped ? resume() : stop('Stopped.');
    refreshDryStatus();
  }

  function showCloseTabAction() {
    stopped = true;
    clearTimeout(autoTimer);
    highlight(null);
    setStatus('Submit clicked. Check Jobstreet for confirmation.');
    stopBtn.hidden = false;
    stopBtn.disabled = false;
    stopBtn.textContent = 'Close tab';
    stopBtn.dataset.action = 'close';
    dryStatusRevision++;
    dryStatusEl.textContent = 'DRY RUN: OFF · LIVE · SENT';
    dryStatusEl.dataset.mode = 'live';
    stopBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: 'roletrack-close-current-tab' }).catch(() => {
        setStatus('Could not close this tab. Close it from the browser controls.');
      });
    };
  }

  async function refreshDryStatus() {
    if (!dryStatusEl) return;
    const revision = ++dryStatusRevision;
    if (await isDry()) {
      if (revision !== dryStatusRevision) return;
      countdownRemaining = null;
      dryStatusEl.textContent = 'DRY RUN: ON · SAFE';
      dryStatusEl.dataset.mode = 'safe';
      return;
    }
    const seconds = countdownRemaining ?? await getSubmitCountdown();
    if (revision !== dryStatusRevision) return;
    dryStatusEl.textContent = seconds === 0
      ? 'DRY RUN: OFF · LIVE · NOW'
      : `DRY RUN: OFF · LIVE · ${seconds}s`;
    dryStatusEl.dataset.mode = 'live';
  }

  function highlight(el) {
    if (hl) hl.style.outline = '';
    hl = el || null;
    if (!el) return;
    el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    el.style.outline = '3px solid #e53935';
    el.style.outlineOffset = '3px';
  }

  function stop(msg) {
    stopped = true;
    resumeRequested = false;
    highlight(null);
    clearTimeout(autoTimer);
    setStatus(msg, false);
    if (workerMode) reportWorkerEvent({ phase: 'WAITING_BROWSER', pending: null }).catch(() => {});
  }

  function resume() {
    if (!stopped) return;
    stopped = false;
    resumeRequested = true;
    setStatus('Resuming application…');
    if (!busy) {
      resumeRequested = false;
      tick();
    }
  }

  const isDry = async () => (await store.get('dryRun')).dryRun !== false;
  const isAuto = async () => (await store.get('autoStart')).autoStart === true;
  async function getSubmitCountdown() {
    const { submitCountdownSeconds } = await store.get('submitCountdownSeconds');
    const seconds = Number(submitCountdownSeconds);
    return SUBMIT_COUNTDOWNS.includes(seconds) ? seconds : DEFAULT_SUBMIT_COUNTDOWN;
  }

  /* ---------------- job page / side panel: entry ---------------- */

  const isApplyPage = () => /\/job\/\d+\/apply/.test(location.pathname);

  // The job you are looking at: the URL says so when you picked it from the list (?jobId=...), but the
  // first job a search page shows has no jobId in the URL. In that case read it off the apply button.
  function getCurrentJobId() {
    const q = new URLSearchParams(location.search).get('jobId');
    if (q) return q;
    const m = location.pathname.match(/\/job\/(\d+)/);
    if (m) return m[1];

    const links = [...document.querySelectorAll(SEL.applyBtn)];
    const visible = links.filter((el) => el.getClientRects().length > 0);
    const a = (visible.length ? visible : links)[0];
    const h = a && (a.getAttribute('href') || '').match(/\/job\/(\d+)\/apply/);
    return h ? h[1] : null;
  }

  function findQuickApply() {
    const id = getCurrentJobId();
    if (!id) return { ok: false, reason: 'Open a specific Jobstreet job first.' };

    const a = [...document.querySelectorAll(SEL.applyBtn)].find((el) =>
      (el.getAttribute('href') || '').includes(`/job/${id}/apply`)
    );
    if (!a) return { ok: false, reason: 'No Apply button is available for this job.' };
    if (!/quick apply/i.test(a.textContent)) return { ok: false, reason: 'This job does not use Quick Apply.' };
    return { ok: true, a, id };
  }

  async function markTried(id) {
    const { tried = [] } = await store.get('tried');
    if (!tried.includes(id)) await store.set({ tried: [...tried, id].slice(-500) });
  }

  async function start() {
    if (isApplyPage()) return { ok: false, message: 'You are already on the application page.' };
    ensureOverlay();
    const r = findQuickApply();
    if (!r.ok) {
      setStatus(r.reason);
      return { ok: false, message: r.reason };
    }
    await store.set({ armed: { jobId: r.id, ts: Date.now() } });
    await markTried(r.id);
    setStatus('Opening Quick Apply…');
    await sleep(rand(300, 900)); // keep short so the key press' user activation is still valid
    r.a.click();
    return { ok: true };
  }

  async function autoStartCheck(id) {
    if (stopped || isApplyPage() || !(await isAuto())) return;
    for (let i = 0; ; i++) {
      if (getCurrentJobId() !== id || !(await isAuto())) return;
      if (findQuickApply().ok) break;
      if (i >= 5) return;
      await sleep(SEC);
    }
    const { tried = [] } = await store.get('tried');
    if (tried.includes(id)) return;
    const { armed } = await store.get('armed');
    if (armed && Date.now() - armed.ts < ARM_TTL) return;
    await start();
  }

  function onJobMutation() {
    if (isApplyPage()) return;
    const id = getCurrentJobId();
    if (id === watchedId) return;
    watchedId = id;
    clearTimeout(autoTimer);
    if (id) autoTimer = setTimeout(() => autoStartCheck(id), AUTO_DWELL);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.dryRun || changes.submitCountdownSeconds) refreshDryStatus();
    if (changes.autoStart) {
      clearTimeout(autoTimer);
      if (changes.autoStart.newValue === true) {
        watchedId = null;
        onJobMutation();
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'roletrack-worker-helper') {
      (async () => {
        const { command, args = {} } = message;
        if (command === 'checkJobPage') return { ready: true, quickApplyAvailable: findQuickApply().ok, url: location.href };
        if (command === 'checkCoverUpload') return { complete: coverUploadComplete(), attached: coverAttached() };
        if (command === 'attachTask') {
          let { [workerTaskKey]: task = {} } = await store.get(workerTaskKey);
          if (!task.taskId || task.taskId !== args.taskId) {
            if (!args.task?.taskId || args.task.taskId !== args.taskId) throw new Error('Saved worker task state is missing from extension storage.');
            task = args.task;
            await store.set({ [workerTaskKey]: task });
          }
          workerMode = true;
          workerPaused = args.paused === true;
          workerPending = null;
          stopped = workerPaused;
          if (!flowStarted) runApplyFlow(true);
          else if (!workerPaused) setTimeout(tick, 150);
          return { ok: true };
        }
        if (command === 'startJob') {
          workerMode = true;
          workerPaused = false;
          workerPending = null;
          stopped = false;
          await reportWorkerEvent({ phase: 'APPLYING', pending: null });
          const task = await start();
          return task;
        }
        if (command === 'getTask') return (await store.get(workerTaskKey))[workerTaskKey] || null;
        if (command === 'pauseTask') {
          workerMode = true;
          workerPaused = true;
          stopped = true;
          clearTimeout(autoTimer);
          highlight(null);
          setStatus('Paused for browser takeover. Type resume in the worker terminal after you finish.');
          await reportWorkerEvent({ phase: 'WAITING_BROWSER', pending: null });
          return { ok: true };
        }
        if (command === 'resumeTask') {
          workerMode = true;
          workerPaused = false;
          workerPending = null;
          stopped = false;
          const review = !!document.querySelector(SEL.submitBtn);
          const dryAtReview = review && await isDry();
          await reportWorkerEvent({ phase: dryAtReview ? 'REVIEW_REACHED' : 'APPLYING', pending: null });
          if (dryAtReview) { stopped = true; setStatus('Review reached. Dry run is on, so nothing was submitted.'); }
          else if (!flowStarted) runApplyFlow(true);
          else setTimeout(tick, 150);
          return { ok: true, phase: dryAtReview ? 'REVIEW_REACHED' : 'APPLYING' };
        }
        if (command === 'answerQuestion') return applyWorkerAnswer(args);
        throw new Error(`Unknown helper command: ${command}`);
      })().then(sendResponse, async (error) => {
        if (message.command === 'answerQuestion' && workerPending?.kind === 'coverLetter') {
          sendResponse({ ok: false, waiting: true, message: String(error?.message || error) });
          return;
        }
        if (message.command === 'answerQuestion' && workerPending?.requestId === message.args?.requestId) {
          workerPending = null;
          await reportWorkerEvent({ phase: 'APPLYING', pending: null });
          setTimeout(tick, 25);
        }
        sendResponse({ ok: false, message: String(error?.message || error) });
      });
      return true;
    }
    if (message?.type !== 'roletrack-start-quick-apply') return;
    start().then(sendResponse).catch((err) => sendResponse({ ok: false, message: String(err?.message || err) }));
    return true;
  });

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey && e.code === 'KeyA') start();
    },
    true // capture: still fires if the page stops the event further down
  );

  /* ---------------- apply tab: reading the page ---------------- */

  async function addKnown(ids) {
    const { known = [] } = await store.get('known');
    await store.set({ known: [...new Set([...known, ...ids])] });
  }

  const labelOf = (el) => {
    const labelledBy = (el.getAttribute?.('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent || '').join(' ');
    const label = el.labels?.[0]?.textContent || (el.matches?.('label') ? el.textContent : '') || el.closest?.('label')?.textContent || el.closest?.('fieldset')?.querySelector('legend')?.textContent ||
      (el.querySelector && el.querySelector('legend, label, strong')?.textContent) || '';
    const explicit = (label || labelledBy || el.getAttribute?.('aria-label') || '').trim();
    if (explicit) return explicit;

    // Screening prompts are often plain text immediately before a custom-styled control,
    // without a <label>, aria-labelledby, or fieldset legend. Walk up a few structural levels
    // and use the nearest preceding sibling's visible text; no site-specific classes required.
    let branch = el;
    for (let depth = 0; branch?.parentElement && depth < 5; depth += 1) {
      const parent = branch.parentElement;
      const siblings = [...parent.children];
      for (let i = siblings.indexOf(branch) - 1; i >= 0; i -= 1) {
        const text = (siblings[i].innerText || siblings[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (text && text.length <= 500) return text;
      }
      branch = parent;
    }
    return (el.id || el.name || '').trim();
  };

  const optionInfo = (option) => ({ id: option.id || '', value: option.value, text: option.textContent.trim(), disabled: option.disabled || option.parentElement?.disabled === true });

  async function readQuestions() {
    const { known = [] } = await store.get('known');
    const knownSet = new Set(known);
    const qs = [];

    document.querySelectorAll(SEL.radioGroup).forEach((fs) => {
      // resume / cover-letter pickers are radio groups too, but they are not screening questions
      if (!fs.querySelector('input[name^="questionnaire."]')) return;
      const radios = [...fs.querySelectorAll('input[type="radio"][name^="questionnaire."]')];
      const chosen = radios.find((r) => r.checked);
      qs.push({ id: fs.id || radios[0]?.name, el: fs, label: labelOf(fs), type: 'radio', required: radios.some((r) => r.required) || fs.getAttribute('aria-required') === 'true', answered: !!chosen, value: chosen?.value || '', options: radios.map((r) => ({ id: r.id, value: r.value, text: (r.labels?.[0]?.textContent || r.closest('label')?.textContent || r.value).trim(), disabled: r.disabled })) });
    });

    // <select> has no placeholder on Jobstreet, so "has a value" does not prove it was answered.
    // First time we see a given question id we ask you to confirm it, then remember it.
    document.querySelectorAll(SEL.select).forEach((s) => {
      const hasValue = s.selectedIndex >= 0 && s.value !== '';
      const id = s.id || s.name;
      qs.push({
        id,
        el: s.closest('div') || s,
        label: labelOf(s),
        answered: hasValue && knownSet.has(id),
        needsConfirm: hasValue && !knownSet.has(id),
        type: 'select', required: s.required || s.getAttribute('aria-required') === 'true', value: hasValue ? s.value : '',
        options: [...s.options].map(optionInfo),
      });
    });

    document.querySelectorAll(SEL.textField).forEach((t) => {
      qs.push({ id: t.id || t.name, el: t, label: labelOf(t.closest('div') || t), type: t.tagName.toLowerCase() === 'textarea' ? 'textarea' : (t.type || 'text'), required: t.required || t.getAttribute('aria-required') === 'true', value: t.value, answered: t.value.trim() !== '', options: [] });
    });

    return qs;
  }

  // "Which step am I on?" — works for steps that have no questions too.
  const headsOf = () =>
    [...document.querySelectorAll('h1,h2,h3')]
      .map((h) => h.textContent.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join('~');
  const urlOf = () => location.pathname + location.search;

  function pageSig(qs) {
    const heads = headsOf();
    const tids = [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')))]
      .sort()
      .join(',');
    return [location.pathname + location.search, heads, qs.map((q) => `${q.id}:${q.type}:${q.required}:${q.value}:${q.label}:${(q.options || []).map((o) => `${o.id}=${o.value}=${o.text}:${o.disabled}`).join(';')}`).join('|'), tids].join('||');
  }
  const currentSig = async () => pageSig(await readQuestions());

  async function waitSigChange(sig, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sleep(TEST ? 20 : 300);
      if ((await currentSig()) !== sig) return true;
    }
    return false;
  }

  const errorCount = () => document.querySelectorAll(SEL.invalid).length;

  function requiredEmpty() {
    return [...document.querySelectorAll('input[required], textarea[required], select[required], [aria-required="true"]')].find(
      (el) => {
        if (!('value' in el)) return false;
        if (['hidden', 'radio', 'checkbox', 'file'].includes(el.type)) return false;
        if (box && box.contains(el)) return false;
        return String(el.value).trim() === '';
      }
    );
  }

  async function reportWorkerEvent(event) {
    const { [workerTaskKey]: task = {} } = await store.get(workerTaskKey);
    if (!task.taskId) return;
    await store.set({ [workerTaskKey]: { ...task, ...event, updatedAt: Date.now() } });
    chrome.runtime.sendMessage({ type: 'roletrack-worker-event', taskId: task.taskId, ...event }).catch(() => {});
  }

  async function workerHeartbeatFresh() {
    const state = await store.get(workerHeartbeatKey);
    const heartbeat = state[workerHeartbeatKey];
    const task = (await store.get(workerTaskKey))[workerTaskKey];
    return !!task?.taskId && heartbeat?.taskId === task.taskId && Date.now() - heartbeat.at < 10000;
  }

  async function pauseAfterWorkerDisconnect() {
    workerPaused = true;
    stopped = true;
    workerPending = null;
    highlight(null);
    setStatus('Worker connection lost. Automation is paused; reconnect with worker:run -- --resume.');
    await reportWorkerEvent({ phase: 'WAITING_BROWSER', pending: null });
  }

  function questionPayload(q, qs, kind = 'question') {
    return {
      taskId: null, requestId: crypto.randomUUID(), questionId: q.id, pageSignature: pageSig(qs), kind,
      prompt: q.label || 'Unlabelled required field', controlType: q.type || 'unknown', required: !!q.required,
      currentAnswer: q.value || '', options: (q.options || []).map((option) => ({ ...option })),
    };
  }

  async function waitForWorkerInput(q, qs, kind = 'question') {
    const pending = questionPayload(q, qs, kind);
    const { [workerTaskKey]: task = {} } = await store.get(workerTaskKey);
    pending.taskId = task.taskId;
    workerPending = pending;
    highlight(q.el);
    setStatus(kind === 'coverLetter' ? 'Worker is waiting for a cover letter choice.' : `Waiting for terminal answer: ${pending.prompt}`);
    await reportWorkerEvent({ phase: 'WAITING_INPUT', pending });
  }

  function findUnknownRequired(qs) {
    const known = (el) => qs.some((q) => q.el === el || q.el?.contains?.(el));
    return [...document.querySelectorAll('input[required], textarea[required], select[required], [aria-required="true"]')]
      .find((el) => {
        if (known(el) || el.closest('[data-qa="overlay"]') || el.type === 'hidden' || el.disabled) return false;
        if (el.type === 'file') {
          const coverInput = coverFileInput();
          return el !== coverInput || (!coverSkipped && !coverAttached());
        }
        if (el.type === 'checkbox') return !el.checked;
        if (el.type === 'radio') return !document.querySelector(`input[type="radio"][name="${CSS.escape(el.name)}"]:checked`);
        return !String(el.value || '').trim();
      });
  }

  async function applyWorkerAnswer(args) {
    if (workerPaused) throw new Error('Task is paused for browser takeover.');
    const pending = workerPending;
    if (!pending || args.requestId !== pending.requestId || args.taskId !== pending.taskId || args.questionId !== pending.questionId || args.pageSignature !== pending.pageSignature) throw new Error('The answer does not match the current pending question.');
    const qs = await readQuestions();
    const q = qs.find((item) => item.id === args.questionId);
    if (pageSig(qs) !== pending.pageSignature || (!q && pending.kind !== 'coverLetter')) throw new Error('The page or answer options changed. Please answer the updated question.');
    if (pending.kind === 'coverLetter') {
      if (args.choice === 'skip') { coverSkipped = true; coverBaseline = null; }
      else if (!coverUploadComplete()) throw new Error('The selected cover letter upload has not been confirmed yet.');
    } else if (q.type === 'radio' || q.type === 'select') {
      const option = q.options.find((item) => (args.optionId && item.id === args.optionId) || item.value === args.value);
      if (!option || option.disabled) throw new Error('That option is no longer available.');
      const control = q.type === 'radio'
        ? [...q.el.querySelectorAll('input[type="radio"]')].find((el) => el.id === option.id || el.value === option.value)
        : [...document.querySelectorAll(SEL.select)].find((el) => (el.id || el.name) === q.id);
      if (!control || control.disabled) throw new Error('The answer control is unavailable.');
      if (q.type === 'radio') control.click();
      else { control.value = option.value; control.dispatchEvent(new Event('input', { bubbles: true })); control.dispatchEvent(new Event('change', { bubbles: true })); }
      const reread = (await readQuestions()).find((item) => item.id === q.id);
      if (!reread || reread.value !== option.value) throw new Error('The page did not keep that answer.');
      if (q.needsConfirm) await addKnown([q.id]);
    } else if (['text', 'textarea', 'email', 'tel', 'number', 'search', 'url', 'date', 'datetime-local', 'month', 'time', 'week', 'color', 'password'].includes(q.type)) {
      if (typeof args.value !== 'string') throw new Error('Enter text for this field.');
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(q.el), 'value')?.set;
      if (setter) setter.call(q.el, args.value); else q.el.value = args.value;
      q.el.dispatchEvent(new Event('input', { bubbles: true }));
      q.el.dispatchEvent(new Event('change', { bubbles: true }));
      if (q.el.value !== args.value) throw new Error('The page did not keep that answer.');
    } else throw new Error(`Unsupported required control: ${q.type || 'unknown'}`);
    workerPending = null;
    await reportWorkerEvent({ phase: 'APPLYING', pending: null });
    setTimeout(tick, 25);
    return { ok: true };
  }

  /* ---------------- apply tab: cover letter ---------------- */

  const pageText = () => document.body.innerText || document.body.textContent || '';

  function fileNames() {
    return new Set(pageText().match(FILE_RE) || []);
  }

  function coverAttached() {
    if (workerMode) return !!coverFileInput()?.files?.length;
    for (const inp of document.querySelectorAll(SEL.fileInput)) {
      if (inp.files && inp.files.length) return true;
    }
    if (ADDED_RE.test(pageText())) return true;
    if (coverBaseline) {
      for (const n of fileNames()) if (!coverBaseline.has(n)) return true;
    }
    return false;
  }

  function coverUploadComplete() {
    const input = coverFileInput();
    if (!input) return false;
    if (!input.files?.length) return false;
    const text = pageText();
    if (ADDED_RE.test(text)) return true;
    const uploading = document.querySelector('[role="progressbar"], [aria-busy="true"], [data-testid*="uploading" i]');
    return !uploading && text.includes(input.files[0].name);
  }

  function coverFileInput() {
    const marked = document.querySelector('input[type="file"][data-roletrack-worker-cover]');
    if (marked) return marked;
    const button = document.querySelector(SEL.coverUploadBtn);
    for (let node = button; node && node !== document.body; node = node.parentElement) {
      const inputs = [...node.querySelectorAll(SEL.fileInput)];
      if (inputs.length === 1) return inputs[0];
    }
    return null;
  }

  function disarmGesture() {
    if (!gestureHandler) return;
    window.removeEventListener('keydown', gestureHandler, true);
    window.removeEventListener('pointerdown', gestureHandler, true);
    gestureHandler = null;
  }

  // Chrome only opens a file dialog from a real user gesture. If the automatic click below is blocked,
  // the next key press / click anywhere on the page opens it instead (one shot).
  function armGesture() {
    if (gestureHandler) return;
    gestureHandler = (e) => {
      if (box && box.contains(e.target)) return; // overlay buttons keep their own meaning
      const up = document.querySelector(SEL.coverUploadBtn);
      if (!up) return disarmGesture();
      if (up.contains(e.target)) return disarmGesture(); // you clicked Upload yourself
      if (e.type === 'keydown') {
        if (['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) return;
        if (e.altKey && e.code === 'KeyU') return; // handled by the Alt+U listener
      }
      disarmGesture();
      up.click();
    };
    window.addEventListener('keydown', gestureHandler, true);
    window.addEventListener('pointerdown', gestureHandler, true);
  }

  function resetCover() {
    coverBaseline = null;
    coverSkipped = false;
    manualCoverStepSig = null;
    manualCoverContinueConfirmed = false;
    uploadTried = false;
    disarmGesture();
  }

  /* ---------------- apply tab: Review / Submit ---------------- */

  const jobIdOfApplyPage = () => (location.pathname.match(/\/job\/(\d+)\/apply/) || [])[1] || '';

  async function reviewStep(btn) {
    highlight(null);
    if (workerMode && await isDry()) {
      stopped = true;
      await reportWorkerEvent({ phase: 'REVIEW_REACHED', pending: null, reviewUrl: location.href });
      setStatus('Review reached. Dry run is on, so nothing was submitted. Browser remains open.');
      return false;
    }
    if (await isDry()) {
      setStatus('Review reached. Dry run is on, so nothing was submitted.');
      return false;
    }
    const jobId = jobIdOfApplyPage();
    let done = false;
    try {
      done = sessionStorage.getItem('qa_submitted') === jobId;
    } catch (_) {}
    if (done) {
      stop('Already submitted for this job.');
      return false;
    }

    const submitCountdown = TEST ? 3 : await getSubmitCountdown();
    for (let s = submitCountdown; s > 0; s--) {
      countdownRemaining = s;
      setStatus('Submitting application… Stop to cancel.');
      await refreshDryStatus();
      await sleep(SEC);
      if (stopped) return false;
      if (await isDry()) {
        countdownRemaining = null;
        setStatus('Dry run was turned on. Submission cancelled.');
        return false;
      }
    }
    countdownRemaining = null;
    if (await isDry()) {
      setStatus('Dry run was turned on. Submission cancelled.');
      return false;
    }
    const b = document.querySelector(SEL.submitBtn) || btn;
    try {
      sessionStorage.setItem('qa_submitted', jobId);
    } catch (_) {}
    b.click();
    await store.set({ lastSubmitted: { jobId, ts: Date.now() } });
    if (workerMode) {
      stopped = true;
      await reportWorkerEvent({ phase: 'COMPLETED', pending: null, reviewUrl: location.href });
      setStatus('Submit clicked. Check JobStreet for its confirmation.');
    }
    showCloseTabAction();
    return false;
  }

  /* ---------------- apply tab: one step ---------------- */

  async function step() {
    // 1) Review page
    const submit = document.querySelector(SEL.submitBtn);
    if (submit) return reviewStep(submit);

    // 2) cover letter: open the file dialog, wait until something is attached
    const up = document.querySelector(SEL.coverUploadBtn);
    if (up && !coverBaseline) coverBaseline = fileNames();
    if (workerMode && up && !coverAttached() && !coverSkipped) {
      await waitForWorkerInput({ id: 'cover-letter', el: up, label: 'Cover Letter', type: 'file', required: false, value: '', options: [] }, await readQuestions(), 'coverLetter');
      return false;
    }
    const { manualCoverLetter } = await store.get('manualCoverLetter');
    if (up && manualCoverLetter === true && !manualCoverContinueConfirmed && !coverSkipped) {
      disarmGesture();
      const sig = pageSig(await readQuestions());
      if (manualCoverStepSig && manualCoverStepSig !== sig) {
        manualCoverStepSig = null;
        resetCover();
        return true;
      }
      manualCoverStepSig = sig;
      highlight(up.closest('fieldset') || up.closest('[data-testid^="coverLetter"]') || up);
      setStatus('Add or type your cover letter, then continue or skip this step.', true, 'Continue / skip');
      return false;
    }
    if (up && !coverAttached() && !coverSkipped && manualCoverLetter !== true) {
      highlight(up);
      armGesture();
      if (!uploadTried) {
        uploadTried = true;
        up.click(); // may be blocked by Chrome (no user gesture); the gesture hook above is the fallback
      }
      setStatus(
        'Attach a cover letter, or continue without one. If the file picker did not open, press Alt+U.',
        true,
        'Continue / skip'
      );
      return false;
    }

    // 3) a normal step
    const cont = document.querySelector(SEL.continueBtn);
    if (!cont) {
      setStatus('Continue button not found. Wait for the page to finish loading.');
      return false;
    }

    const qs = await readQuestions();

    if (workerMode) {
      const unknown = findUnknownRequired(qs);
      if (unknown) {
        await waitForWorkerInput({ id: unknown.id || unknown.name || 'unknown-required-control', el: unknown, label: labelOf(unknown.closest('label,div,fieldset') || unknown), type: 'unknown', required: true, value: unknown.value || '', options: [] }, qs, 'unknown');
        return false;
      }
      const waiting = qs.find((q) => !q.answered || q.needsConfirm);
      if (waiting) { await waitForWorkerInput(waiting, qs); return false; }
    }

    const empty = qs.find((q) => !q.answered && !q.needsConfirm);
    if (empty) {
      highlight(empty.el);
      setStatus(`Answer required: ${empty.label || 'new question'}`);
      return false;
    }

    const toConfirm = qs.filter((q) => q.needsConfirm);
    if (toConfirm.length) {
      highlight(toConfirm[0].el);
      setStatus('Confirm the prefilled answer before continuing.', true);
      return false;
    }

    const missing = requiredEmpty();
    if (missing) {
      highlight(missing);
      setStatus('Complete the required field to continue.');
      return false;
    }

    // 4) everything answered (or nothing to answer, e.g. Skills / Education): go on
    highlight(null);
    if (stepsDone >= MAX_STEPS) {
      stop(`Stopped after ${MAX_STEPS} steps. Please review this application manually.`);
      return false;
    }

    setStatus('Checking this step…');
    const sig = pageSig(qs);
    const errBefore = errorCount();
    await sleep(rand(1500, 4000));
    if (stopped) return false;
    if ((await currentSig()) !== sig) return true; // page already moved while we waited

    const onCover = !!coverBaseline; // a freshly attached file may still be uploading: allow retries
    const urlBefore = urlOf();
    const headsBefore = headsOf();
    let btn = null;
    let moved = false;
    for (let attempt = 0; attempt < (onCover ? 3 : 1) && !moved; attempt++) {
      if (workerMode && !(await workerHeartbeatFresh())) { await pauseAfterWorkerDisconnect(); return false; }
      const c = document.querySelector(SEL.continueBtn);
      if (!c) return false;
      if (attempt) await sleep(2 * SEC);
      if (stopped) return false;
      btn = c;
      c.click();
      if (!attempt) stepsDone++;
      moved = await waitSigChange(sig, TEST ? 300 : 5000);
    }
    if (!moved) {
      stop('Step did not advance. Check the page and continue manually.');
      return false;
    }
    if (errorCount() > errBefore) {
      stop('A validation error appeared. Review the highlighted fields.');
      return false;
    }

    // "Something on the page changed" is not the same as "we left this step": a finished upload,
    // a toast, etc. also change the DOM. Only treat it as a new step if the URL / headings changed
    // or the Continue button we clicked was thrown away. Otherwise look at the page again
    // (step() re-checks everything and clicks Continue again if it is really ready).
    const left = !btn.isConnected || urlOf() !== urlBefore || headsOf() !== headsBefore;
    if (left || !document.querySelector('[data-testid^="coverLetter"]')) resetCover();
    await sleep(rand(400, 800)); // let the next step finish rendering
    return true;
  }

  async function tick() {
    if (busy || stopped || workerPaused || workerPending) return;
    if (workerMode && !(await workerHeartbeatFresh())) { await pauseAfterWorkerDisconnect(); return; }
    busy = true;
    let advanced = false;
    try {
      advanced = await step();
    } catch (err) {
      console.error('[QA]', err);
      stop('Helper error. Check the page or reload the extension.');
    } finally {
      busy = false;
    }
    if (resumeRequested && !stopped) {
      resumeRequested = false;
      tick();
      return;
    }
    if (advanced) tick();
  }

  async function onConfirm() {
    if (stopped) return;
    const { manualCoverLetter } = await store.get('manualCoverLetter');
    if (manualCoverLetter === true && document.querySelector(SEL.coverUploadBtn)) {
      manualCoverContinueConfirmed = true;
      tick();
      return;
    }
    const up = document.querySelector(SEL.coverUploadBtn);
    if (up && !coverAttached()) {
      coverSkipped = true; // "skip cover letter"
      coverBaseline = null;
      disarmGesture();
      tick();
      return;
    }
    const qs = await readQuestions();
    await addKnown(qs.filter((q) => q.needsConfirm).map((q) => q.id));
    tick();
  }

  /* ---------------- apply tab: start / resume ---------------- */

  function runApplyFlow(deferFirstTick = false) {
    if (flowStarted) return;
    flowStarted = true;
    ensureOverlay();

    // user answered something / picked a file -> re-check; a select the user touched counts as confirmed
    document.addEventListener(
      'change',
      (e) => {
        if (e.target.matches && e.target.matches(SEL.select)) addKnown([e.target.id || e.target.name]);
        setTimeout(tick, 50);
      },
      true
    );

    window.addEventListener(
      'keydown',
      (e) => {
        if (e.altKey && e.code === 'KeyU') {
          disarmGesture();
          document.querySelector(SEL.coverUploadBtn)?.click();
        }
      },
      true
    );

    let timer;
    new MutationObserver((muts) => {
      if (muts.every((m) => box && box.contains(m.target))) return; // ignore our own overlay
      clearTimeout(timer);
      timer = setTimeout(tick, 400);
    }).observe(document.body, { childList: true, subtree: true });

    if (deferFirstTick) setTimeout(tick, 150);
    else tick();
  }

  async function maybeResume() {
    const m = location.pathname.match(/\/job\/(\d+)\/apply/);
    if (!m) return;
    const jobId = m[1];

    let ok = false;
    try {
      ok = sessionStorage.getItem('qa_active') === jobId; // survives a reload of this tab
    } catch (_) {}

    if (!ok) {
      const { armed } = await store.get('armed');
      if (armed && armed.jobId === jobId && Date.now() - armed.ts <= ARM_TTL) {
        ok = true;
        await store.remove('armed');
        try {
          sessionStorage.setItem('qa_active', jobId);
        } catch (_) {}
      }
    }
    const { [workerTaskKey]: workerTask = {} } = await store.get(workerTaskKey);
    if (ok) {
      workerMode = !!workerTask.taskId && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(workerTask.phase);
      if (workerMode && workerTask.phase === 'WAITING_BROWSER') { workerPaused = true; stopped = true; }
      runApplyFlow();
    }
  }

  console.log('[QA] Quick Apply Helper loaded');
  maybeResume().then(() => {
    if (isApplyPage()) return;
    if (!(msgEl && msgEl.textContent)) {
      setStatus('Ready. Use Sync + Quick Apply or press Alt+A.');
    }
    new MutationObserver(onJobMutation).observe(document.body, { childList: true, subtree: true });
    onJobMutation();
  });
})();
