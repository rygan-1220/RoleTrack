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
  let stepsDone = 0;
  let flowStarted = false;
  let box, msgEl, dryStatusEl, confirmBtn, stopBtn, hl;
  let countdownRemaining = null;
  let dryStatusRevision = 0;

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
    stopBtn.hidden = !isApplyPage();
    stopBtn.disabled = stopped;
    stopBtn.textContent = stopped ? 'Stopped' : 'Stop application';
    stopBtn.dataset.action = 'stop';
    stopBtn.onclick = () => stop('Stopped.');
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
    highlight(null);
    clearTimeout(autoTimer);
    setStatus(msg, false);
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

  const labelOf = (el) =>
    ((el.querySelector && el.querySelector('legend, label, strong')?.textContent) || el.id || '').trim().slice(0, 50);

  async function readQuestions() {
    const { known = [] } = await store.get('known');
    const knownSet = new Set(known);
    const qs = [];

    document.querySelectorAll(SEL.radioGroup).forEach((fs) => {
      // resume / cover-letter pickers are radio groups too, but they are not screening questions
      if (!fs.querySelector('input[name^="questionnaire."]')) return;
      qs.push({ id: fs.id, el: fs, label: labelOf(fs), answered: !!fs.querySelector('input[type="radio"]:checked') });
    });

    // <select> has no placeholder on Jobstreet, so "has a value" does not prove it was answered.
    // First time we see a given question id we ask you to confirm it, then remember it.
    document.querySelectorAll(SEL.select).forEach((s) => {
      const hasValue = s.selectedIndex >= 0 && s.value !== '';
      qs.push({
        id: s.id,
        el: s.closest('div') || s,
        label: labelOf(s.closest('div') || s),
        answered: hasValue && knownSet.has(s.id),
        needsConfirm: hasValue && !knownSet.has(s.id),
      });
    });

    document.querySelectorAll(SEL.textField).forEach((t) => {
      qs.push({ id: t.id || t.name, el: t, label: labelOf(t.closest('div') || t), answered: t.value.trim() !== '' });
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
    return [location.pathname + location.search, heads, qs.map((q) => q.id).join('|'), tids].join('||');
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

  /* ---------------- apply tab: cover letter ---------------- */

  const pageText = () => document.body.innerText || document.body.textContent || '';

  function fileNames() {
    return new Set(pageText().match(FILE_RE) || []);
  }

  function coverAttached() {
    for (const inp of document.querySelectorAll(SEL.fileInput)) {
      if (inp.files && inp.files.length) return true;
    }
    if (ADDED_RE.test(pageText())) return true;
    if (coverBaseline) {
      for (const n of fileNames()) if (!coverBaseline.has(n)) return true;
    }
    return false;
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
    if (busy || stopped) return;
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
      disarmGesture();
      tick();
      return;
    }
    const qs = await readQuestions();
    await addKnown(qs.filter((q) => q.needsConfirm).map((q) => q.id));
    tick();
  }

  /* ---------------- apply tab: start / resume ---------------- */

  function runApplyFlow() {
    if (flowStarted) return;
    flowStarted = true;
    ensureOverlay();

    // user answered something / picked a file -> re-check; a select the user touched counts as confirmed
    document.addEventListener(
      'change',
      (e) => {
        if (e.target.matches && e.target.matches(SEL.select)) addKnown([e.target.id]);
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

    tick();
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
    if (ok) runApplyFlow();
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
