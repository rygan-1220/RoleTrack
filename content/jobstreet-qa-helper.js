// JobStreet Quick Apply Helper — content script (v0.2.0)
//
// Job page / side panel : Alt+A (or the on-screen button) -> opens the Quick apply tab.
//                         Optional "auto start": stay on a Quick apply job for 3s -> opens it.
// Apply tab             : walks the steps. Clicks Continue when everything is answered,
//                         pauses on new questions, opens the cover-letter file dialog,
//                         continues once a cover letter is attached, and at the Review page
//                         clicks "Submit application" (5s countdown) — only when DRY RUN is off.
// DRY RUN (checkbox on the overlay, ON by default): everything runs as normal EXCEPT the final
// "Submit application" click, which is never made. Untick it to allow submitting.

(() => {
  'use strict';
  if (window.__qaLoaded) return;
  window.__qaLoaded = true;

  const TEST = !!window.__QA_TEST; // shrinks delays in the sandbox test
  const DAILY_LIMIT = 20;
  const ARM_TTL = 2 * 60 * 1000;
  const MAX_STEPS = 12;
  const AUTO_DWELL = TEST ? 30 : 3000;
  const SUBMIT_COUNTDOWN = TEST ? 3 : 5;
  const SEC = TEST ? 10 : 1000;

  // All selectors live here. If JobStreet changes its markup, edit this block only.
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
  let box, msgEl, confirmBtn, startBtn, dryChk, autoChk, autoWrap, hl;

  // cover-letter step state
  let coverBaseline = null; // filenames visible when we first saw the Upload button
  let coverSkipped = false;
  let uploadTried = false;
  let gestureHandler = null;

  // job-page auto start state
  let watchedId = null;
  let autoTimer = null;

  /* ---------------- overlay ---------------- */

  function ensureOverlay() {
    if (box) {
      if (!box.isConnected) document.body.appendChild(box); // page re-rendered and dropped it
      return;
    }
    box = document.createElement('div');
    box.setAttribute('data-qa', 'overlay');
    box.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#222;color:#fff;' +
      'padding:10px 12px;border-radius:8px;font:13px/1.4 sans-serif;max-width:280px;';

    msgEl = document.createElement('div');
    msgEl.setAttribute('data-qa', 'msg');

    confirmBtn = document.createElement('button');
    confirmBtn.setAttribute('data-qa', 'confirm');
    confirmBtn.style.cssText = 'margin-top:6px;margin-right:6px;display:none;';
    confirmBtn.onclick = onConfirm;

    startBtn = document.createElement('button');
    startBtn.setAttribute('data-qa', 'start');
    startBtn.textContent = '▶ 开始投递（Alt+A）';
    startBtn.style.cssText = 'margin-top:6px;margin-right:6px;';
    startBtn.onclick = start;

    const stopBtn = document.createElement('button');
    stopBtn.setAttribute('data-qa', 'stop');
    stopBtn.textContent = '停止';
    stopBtn.style.cssText = 'margin-top:6px;';
    stopBtn.onclick = () => stop('已停止');

    const dryWrap = document.createElement('label');
    dryWrap.style.cssText = 'display:block;margin-top:6px;font-size:12px;';
    dryChk = document.createElement('input');
    dryChk.type = 'checkbox';
    dryChk.setAttribute('data-qa', 'dry');
    dryChk.checked = true;
    dryChk.onchange = () => store.set({ dryRun: dryChk.checked });
    dryWrap.append(dryChk, ' 试运行（照常点 Continue，但不点 Submit）');

    autoWrap = document.createElement('label');
    autoWrap.style.cssText = 'display:block;margin-top:4px;font-size:12px;';
    autoChk = document.createElement('input');
    autoChk.type = 'checkbox';
    autoChk.setAttribute('data-qa', 'auto');
    autoChk.checked = false;
    autoChk.onchange = () => store.set({ autoStart: autoChk.checked });
    autoWrap.append(autoChk, ' 自动开始（停留 3 秒的 Quick apply 职位）');

    box.append(msgEl, confirmBtn, startBtn, stopBtn, dryWrap, autoWrap);
    document.body.appendChild(box);

    Promise.all([store.get('dryRun'), store.get('autoStart')]).then(([d, a]) => {
      dryChk.checked = d.dryRun !== false;
      autoChk.checked = a.autoStart === true;
    });
  }

  function setStatus(msg, showConfirm = false, confirmLabel = '确认并继续') {
    ensureOverlay();
    msgEl.textContent = msg;
    confirmBtn.textContent = confirmLabel;
    confirmBtn.style.display = showConfirm ? 'inline-block' : 'none';
    const onApply = isApplyPage();
    startBtn.style.display = onApply ? 'none' : 'inline-block';
    autoWrap.style.display = onApply ? 'none' : 'block';
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
    if (!id) return { ok: false, reason: '页面上没有找到申请按钮，请先点开一个职位' };

    const a = [...document.querySelectorAll(SEL.applyBtn)].find((el) =>
      (el.getAttribute('href') || '').includes(`/job/${id}/apply`)
    );
    if (!a) return { ok: false, reason: '没有找到这个职位的申请按钮（可能已申请或已关闭）' };
    if (!/quick apply/i.test(a.textContent)) return { ok: false, reason: '不是 Quick apply，已跳过' };
    return { ok: true, a, id };
  }

  const today = () => new Date().toISOString().slice(0, 10);

  async function withinDailyLimit() {
    const { daily } = await store.get('daily');
    return !daily || daily.date !== today() || daily.count < DAILY_LIMIT;
  }

  async function bumpDaily() {
    const { daily } = await store.get('daily');
    const count = daily && daily.date === today() ? daily.count + 1 : 1;
    await store.set({ daily: { date: today(), count } });
  }

  async function markTried(id) {
    const { tried = [] } = await store.get('tried');
    if (!tried.includes(id)) await store.set({ tried: [...tried, id].slice(-500) });
  }

  async function start() {
    if (isApplyPage()) return;
    ensureOverlay();
    const r = findQuickApply();
    if (!r.ok) return setStatus(r.reason);
    if (!(await withinDailyLimit())) return setStatus(`已达今日上限（${DAILY_LIMIT}）`);

    await store.set({ armed: { jobId: r.id, ts: Date.now() } });
    await bumpDaily();
    await markTried(r.id);
    setStatus('即将打开申请页…');
    await sleep(rand(300, 900)); // keep short so the key press' user activation is still valid
    r.a.click();
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey && e.code === 'KeyA') start();
    },
    true // capture: still fires if the page stops the event further down
  );

  // Auto start: the job panel re-renders when you pick another job, so watch the DOM / URL.
  async function autoStartCheck(id) {
    if (stopped || isApplyPage() || !(await isAuto())) return;
    for (let i = 0; ; i++) {
      if (getCurrentJobId() !== id) return; // you moved on
      if (findQuickApply().ok) break;
      if (i >= 5) return; // not Quick apply / panel never rendered: leave it alone
      await sleep(SEC);
    }
    const { tried = [] } = await store.get('tried');
    if (tried.includes(id)) return;
    const { armed } = await store.get('armed');
    if (armed && Date.now() - armed.ts < ARM_TTL) return; // one apply tab at a time
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

    // <select> has no placeholder on JobStreet, so "has a value" does not prove it was answered.
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
    uploadTried = false;
    disarmGesture();
  }

  /* ---------------- apply tab: Review / Submit ---------------- */

  const jobIdOfApplyPage = () => (location.pathname.match(/\/job\/(\d+)\/apply/) || [])[1] || '';

  async function reviewStep(btn) {
    highlight(null);
    if (await isDry()) {
      setStatus('[试运行] 已到 Review 页：试运行不会提交。要提交请取消勾选「试运行」');
      return false;
    }
    const jobId = jobIdOfApplyPage();
    let done = false;
    try {
      done = sessionStorage.getItem('qa_submitted') === jobId;
    } catch (_) {}
    if (done) {
      stop('这个职位已经提交过了，不再重复点击');
      return false;
    }

    for (let s = SUBMIT_COUNTDOWN; s > 0; s--) {
      setStatus(`${s} 秒后提交申请…点「停止」可取消`);
      await sleep(SEC);
      if (stopped) return false;
    }
    if (await isDry()) {
      setStatus('[试运行] 已改回试运行，不提交');
      return false;
    }
    const b = document.querySelector(SEL.submitBtn) || btn;
    try {
      sessionStorage.setItem('qa_submitted', jobId);
    } catch (_) {}
    b.click();
    await store.set({ lastSubmitted: { jobId, ts: Date.now() } });
    stop('已点击 Submit application，请确认是否投递成功');
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
    if (up && !coverAttached() && !coverSkipped) {
      highlight(up);
      armGesture();
      if (!uploadTried) {
        uploadTried = true;
        up.click(); // may be blocked by Chrome (no user gesture); the gesture hook above is the fallback
      }
      setStatus(
        'cover letter：已尝试自动点 Upload。没弹出文件窗口的话，按任意键或点一下页面即可打开。选好文件后会自动继续；如果选好了却没反应，点下面的按钮（不想附 cover letter 也点它）',
        true,
        '已选好 / 跳过，继续'
      );
      return false;
    }

    // 3) a normal step
    const cont = document.querySelector(SEL.continueBtn);
    if (!cont) {
      setStatus('没有找到 Continue / Submit 按钮：页面载入中，或是未识别的页面');
      return false;
    }

    const qs = await readQuestions();

    const empty = qs.find((q) => !q.answered && !q.needsConfirm);
    if (empty) {
      highlight(empty.el);
      setStatus(`有新问题需要你回答（第 ${qs.indexOf(empty) + 1}/${qs.length} 题：${empty.label || empty.id}）`);
      return false;
    }

    const toConfirm = qs.filter((q) => q.needsConfirm);
    if (toConfirm.length) {
      highlight(toConfirm[0].el);
      setStatus('首次遇到这些下拉题，请确认预填的答案是对的', true);
      return false;
    }

    const missing = requiredEmpty();
    if (missing) {
      highlight(missing);
      setStatus('这一步有必填栏位还是空的，请填写');
      return false;
    }

    // 4) everything answered (or nothing to answer, e.g. Skills / Education): go on
    highlight(null);
    if (stepsDone >= MAX_STEPS) {
      stop(`已超过 ${MAX_STEPS} 步，疑似不是普通 Quick Apply，已停止`);
      return false;
    }

    setStatus('运行中…');
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
      stop('点了 Continue 但页面没变，可能有错误提示或文件还没传完，已停止');
      return false;
    }
    if (errorCount() > errBefore) {
      stop('点 Continue 之后出现了错误提示，已停止，请检查');
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
      stop('脚本出错，已停止（见控制台）');
    } finally {
      busy = false;
    }
    if (advanced) tick();
  }

  async function onConfirm() {
    if (stopped) return;
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
      setStatus('已就绪：打开一个 Quick apply 职位，按 Alt+A 或点下面的按钮');
    }
    new MutationObserver(onJobMutation).observe(document.body, { childList: true, subtree: true });
    onJobMutation();
  });
})();
