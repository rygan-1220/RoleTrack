(function () {
  'use strict';
  if (window.JobExperience) return; // Re-scanning never starts another timer.

  const WORD_NUMBERS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
  const NUMBER = '(?:\\d+(?:\\.\\d+)?|' + Object.keys(WORD_NUMBERS).join('|') + ')';
  const YEAR_PATTERN = new RegExp('(?<![\\w.])(' + NUMBER + ')\\s*(\\+)?(?:\\s*(?:-|–|—|to)\\s*(' + NUMBER + '))?\\s*(\\+)?\\s*(years?|yrs?|months?|mos?)\\b', 'gi');
  const TECH = /\b(python|java(?:script)?|typescript|sql|react|angular|vue|node\.?js|c\+\+|c#|\.net|aws|azure|gcp|kubernetes|docker|sap|salesforce|golang|rust)\b/i;
  const ENTRY_LEVEL = /\b(?:no (?:prior |previous |relevant |work )?experience|without (?:prior |previous |work )?experience|fresh\s*grads?(?:uate)?s?|recent graduates?|entry[ -]level|graduate\s+(?:role|position|opportunit|job)|early[ -]career)\b/i;
  let lastText = null;
  let lastContainer = null;
  let lastUrl = null;
  let result = { available: false, range: null, count: 0 };

  function getContainer() {
    if (/(^|\.)linkedin\.com$/.test(location.hostname)) {
      return document.querySelector('.jobs-description__content, .jobs-box__html-content, article.jobs-description__container');
    }
    if (/(^|\.)jobstreet\.com(?:\.my)?$/.test(location.hostname)) {
      return document.querySelector('[data-automation="jobAdDetails"], [data-testid="job-detail-description"], .job-description');
    }
    return null;
  }

  function clearMarks() {
    document.querySelectorAll('mark.exp-hl').forEach(mark => {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent));
      parent.normalize();
    });
  }

  function collect(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest('script, style, noscript, textarea, input, [contenteditable="true"]')
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let text = '';
    let previousBlock = null;
    let node;
    while ((node = walker.nextNode())) {
      const block = node.parentElement.closest('p, li, div, section, article, h1, h2, h3, h4, br');
      if (previousBlock && block !== previousBlock) text += '\n';
      previousBlock = block;
      nodes.push({ node, start: text.length });
      text += node.nodeValue;
    }
    return { nodes, text };
  }

  function numberValue(value) { return Object.prototype.hasOwnProperty.call(WORD_NUMBERS, value.toLowerCase()) ? WORD_NUMBERS[value.toLowerCase()] : Number(value); }

  // Read one line/sentence at a time and carry qualification headings forward. This avoids
  // borrowing "experience" from an adjacent bullet and recognises preferred vs required labels.
  function analyze(text) {
    const matches = [];
    let section = 'unspecified', base = 0;
    for (const line of text.split('\n')) {
      const heading = line.replace(/^[•\d.\s]+/, '').trim();
      if (/^(required qualifications|minimum qualifications|requirements|qualifications|what you bring|what we.re looking for)\s*:?$/i.test(heading)) section = 'required';
      else if (/^(preferred qualifications|preferred|nice to have|bonus points)\s*:?$/i.test(heading)) section = 'preferred';
      else if (/^(responsibilities|benefits|about us|about the company|what you will do|job description)\s*:?$/i.test(heading)) section = 'unspecified';

      const clauses = [...line.matchAll(/.+?(?:[;!?]|,(?=\s*(?:but|prefer(?:red|ably)?|ideally|minimum|at least)\b)|$)/gi)];
      for (const clauseMatch of clauses) {
        const clause = clauseMatch[0], clauseOffset = clauseMatch.index || 0;
        const sentences = [...clause.matchAll(/.+?(?:\.(?=\s+[A-Z]|$)|$)/g)];
        for (const sentenceMatch of sentences) {
          const sentence = sentenceMatch[0], lower = sentence.toLowerCase();
          if (/\b(founded|established|anniversary|years? of history)\b|\b(?:our company|our business|company|we)\s+(?:has|have|celebrates?)\b/i.test(sentence)) continue;
          const noPrior = /\bno (?:prior |previous |relevant |working )?experience (?:is )?(?:required|necessary|needed)\b|\bwithout (?:prior |previous )?experience\b/i.test(sentence);
          const explicit = /\b(required|must|minimum|at least|mandatory|essential|need(?:s|ed)?|min\.)\b/i.test(sentence);
          const relevantWords = /\b(experience|exp\.?|working|professional|commercial)\b/i.test(sentence) || TECH.test(sentence) || /^\s*(?:of )?(?:relevant |professional |commercial )?experience\b/i.test(sentence);
          if (!relevantWords && !noPrior) continue;
          const strength = /\b(prefer(?:red|ably)?|desirable|nice.to.have|advantage|bonus|not (?:strictly )?(?:required|essential|mandatory))\b/i.test(sentence) ? 'preferred' : explicit ? 'required' : section;
          YEAR_PATTERN.lastIndex = 0;
          for (const m of sentence.matchAll(YEAR_PATTERN)) {
            const after = sentence.slice(m.index + m[0].length);
            if (/^\s*[- ]?\s*(?:degree|bachelor|master|phd|diploma|course|warranty|contract|old)\b/i.test(after)) continue;
            const unit = m[5].toLowerCase();
            const divisor = /^(?:months?|mos?)/.test(unit) ? 12 : 1;
            const a = numberValue(m[1]) / divisor, b = m[3] ? numberValue(m[3]) / divisor : null;
            if (!Number.isFinite(a) || a > 100 || (b !== null && (b < a || b > 100))) continue;
            const before = sentence.slice(0, m.index);
            if (!noPrior && !TECH.test(after) && !/\b(experience|exp\.?|working|professional|commercial)\b/i.test(sentence) && !/^\s*(?:in|with|using|as an?)\b/i.test(after)) continue;
            const upper = /\b(?:less than|under|up to|at most|maximum|no more than)\s*$/i.test(before);
            const sentenceTrimmed = sentence.trim();
            const leading = sentence.length - sentence.trimStart().length;
            const start = base + clauseOffset + (sentenceMatch.index || 0) + leading;
            const end = start + sentenceTrimmed.length;
            const existing = matches.find(item => item.start === start && item.end === end);
            if (existing) {
              if (!upper) existing.min = existing.min == null ? a : Math.min(existing.min, a);
              existing.max = b != null ? (existing.max == null ? b : Math.max(existing.max, b)) : (existing.max == null && upper ? a : existing.max);
              existing.plus ||= Boolean(m[2] || m[4]);
            } else {
              matches.push({ start, end, min: upper ? null : a, max: b ?? (upper ? a : null), plus: Boolean(m[2] || m[4]), strength });
            }
          }
        }
      }
      base += line.length + 1;
    }
    return matches;
  }

  function publish() {
    updateExperienceBanner();
    // A closed panel has no listener; that is expected.
    try { chrome.runtime.sendMessage({ type: 'experience-updated', result }).catch(() => {}); } catch {}
  }

  function updateExperienceBanner() {
    let banner = document.querySelector('[data-roletrack-experience-banner]');
    if (!result.available) {
      banner?.remove();
      return;
    }
    if (!banner) {
      banner = document.createElement('button');
      banner.type = 'button';
      banner.dataset.roletrackExperienceBanner = '';
      banner.setAttribute('aria-live', 'polite');
      banner.title = 'Click to jump to the highlighted experience requirement';
      banner.addEventListener('click', jump);
      document.documentElement.appendChild(banner);
    }
    if (!result.range) {
      banner.replaceChildren();
      const label = document.createElement('span');
      label.textContent = 'REQUIRED EXPERIENCE';
      label.dataset.roletrackExperienceLabel = '';
      const value = document.createElement('strong');
      value.textContent = 'No experience';
      value.dataset.roletrackExperienceValue = '';
      const detail = document.createElement('span');
      detail.textContent = 'detected';
      detail.dataset.roletrackExperienceDetail = '';
      banner.append(label, value, detail);
      banner.disabled = true;
      banner.dataset.roletrackEntryLevel = String(ENTRY_LEVEL.test(lastText || ''));
      return;
    }
    const { min, max, plus } = result.range;
    const years = min === max ? `${min}` : `${min}–${max}`;
    const count = `${result.count} ${result.count === 1 ? 'mention' : 'mentions'} found`;
    banner.replaceChildren();
    const label = document.createElement('span');
    label.textContent = 'REQUIRED EXPERIENCE';
    label.dataset.roletrackExperienceLabel = '';
    const value = document.createElement('strong');
    value.textContent = `${years}${plus ? '+' : ''} years`;
    value.dataset.roletrackExperienceValue = '';
    const detail = document.createElement('span');
    detail.textContent = count;
    detail.dataset.roletrackExperienceDetail = '';
    banner.append(label, value, detail);
    banner.dataset.roletrackEntryLevel = String(ENTRY_LEVEL.test(lastText || ''));
    banner.disabled = false;
  }

  function scan() {
    const container = getContainer();
    const text = container ? collect(container).text : '';
    if (container === lastContainer && text === lastText && location.href === lastUrl) return result;
    lastContainer = container;
    lastText = text;
    lastUrl = location.href;
    clearMarks();
    result = { available: Boolean(text.trim()), range: null, count: 0 };
    if (!text.trim()) { publish(); return result; }

    const { nodes, text: fullText } = collect(container);
    const matches = analyze(fullText);
    for (const { node, start } of nodes) {
      const local = matches.filter(m => m.start < start + node.length && m.end > start);
      if (!local.length) continue;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const match of local) {
        const from = Math.max(0, match.start - start);
        const to = Math.min(node.length, match.end - start);
        fragment.append(document.createTextNode(node.nodeValue.slice(cursor, from)));
        const mark = document.createElement('mark');
        mark.className = `exp-hl exp-hl-${match.strength || 'unspecified'}`;
        mark.textContent = node.nodeValue.slice(from, to);
        fragment.append(mark);
        cursor = to;
      }
      fragment.append(document.createTextNode(node.nodeValue.slice(cursor)));
      node.replaceWith(fragment);
    }
    result.count = matches.length;
    const mins = matches.map(m => m.min).filter(Number.isFinite);
    const maxs = matches.map(m => m.max).filter(Number.isFinite);
    if (matches.length && (mins.length || maxs.length)) result.range = {
      min: mins.length ? Math.min(...mins) : Math.min(...maxs),
      max: maxs.length ? Math.max(...maxs) : Math.max(...mins),
      plus: matches.some(m => m.plus),
    };
    publish();
    return result;
  }

  function jump() {
    const mark = document.querySelector('mark.exp-hl');
    if (!mark) return;
    mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    mark.classList.add('exp-hl-flash');
    setTimeout(() => mark.classList.remove('exp-hl-flash'), 1200);
  }

  window.JobExperience = { scan, jump };
  scan();
  setInterval(scan, 800);
})();
