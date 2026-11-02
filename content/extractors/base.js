// Shared extraction helpers.
//
// These files are injected into the job page by the popup (chrome.scripting.executeScript),
// so they are CLASSIC scripts, not ES modules. Everything hangs off window.JobTracker.
//
// Extraction is layered. Each layer returns a partial { role, company, ... } object and
// JT.merge() takes, per field, the first non-empty value in priority order.
// A field nothing could find stays '' — we never guess.

(function () {
  const JT = (window.JobTracker = window.JobTracker || {});
  JT.extractors = JT.extractors || {};

  const FIELDS = ['company', 'role', 'salary', 'location', 'employmentType', 'url', 'jobDescription'];
  const MAX_DESCRIPTION = 20000;

  // ---------------------------------------------------------------- text helpers

  const clean = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();

  // Sites often render a visually-hidden copy of a label next to the visible one, which makes
  // innerText read "ABC ABC". Collapse an exact doubling.
  const collapseRepeat = (s) => {
    const m = /^(.+?)\s+\1$/.exec(s);
    return m ? m[1] : s;
  };

  // innerText respects visibility/layout; textContent is the fallback (and what jsdom offers).
  const textOf = (el) => (el ? collapseRepeat(clean(el.innerText || el.textContent)) : '');

  function descriptionOf(el) {
    if (!el) return '';
    const blockTags = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4']);
    let out = '';
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) { out += node.nodeValue || ''; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName;
      if (tag === 'BR') { out += '\n'; return; }
      if (tag === 'LI') out += '\n• ';
      for (const child of node.childNodes) walk(child);
      if (blockTags.has(tag)) out += '\n';
    }
    walk(el);
    return out.replace(/\r\n?/g, '\n').replace(/[\t\u00a0 ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function firstText(root, selectors) {
    for (const selector of selectors) {
      let el = null;
      try {
        el = root.querySelector(selector);
      } catch (_) {
        continue; // invalid selector should never break extraction
      }
      const text = textOf(el);
      if (text) return text;
    }
    return '';
  }

  /** { role: [selectors], company: [selectors] } -> { role: 'text', company: 'text' } */
  function fromSelectors(root, map) {
    const out = {};
    for (const [field, selectors] of Object.entries(map)) out[field] = firstText(root, selectors);
    return out;
  }

  /**
   * Resolve with check()'s value as soon as it is truthy, or null after timeoutMs.
   * LinkedIn/Jobstreet render job details after the initial load, so we wait for the
   * title to exist. A MutationObserver means no polling loop.
   */
  function waitFor(check, timeoutMs = 3000) {
    return new Promise((resolve) => {
      let finished = false;
      let observer = null;
      let timer = null;

      const finish = (value) => {
        if (finished) return;
        finished = true;
        if (observer) observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      };
      const tryNow = () => {
        let value = null;
        try {
          value = check();
        } catch (_) {
          /* keep waiting */
        }
        if (value) finish(value);
      };

      timer = setTimeout(() => finish(null), timeoutMs);
      observer = new MutationObserver(tryNow);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      tryNow();
    });
  }

  /**
   * All visible-ish text under `el`, one text node at a time, joined with spaces.
   * innerText/textContent glue neighbouring inline elements together ("RM 7K/monthFull-time"),
   * which breaks the salary / job-type patterns. This keeps them apart.
   */
  function spacedText(el) {
    if (!el) return '';
    const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
    const parts = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const tag = node.parentElement && node.parentElement.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
      const text = clean(node.nodeValue);
      if (text) parts.push(text);
    }
    return parts.join(' ');
  }

  /**
   * The smallest ancestor of `el` that still looks like "the header of the job ad":
   * grows outward until the text gets too long (which means we've reached the page body).
   * Lets us find salary/location/company *near the title* without relying on class names.
   */
  function headerRegion(el, maxChars = 1200, maxLevels = 6) {
    let best = el;
    let node = el;
    for (let i = 0; i < maxLevels && node.parentElement; i++) {
      node = node.parentElement;
      if (node.tagName === 'BODY' || node.tagName === 'MAIN') break;
      if (textOf(node).length > maxChars) break;
      best = node;
    }
    return best;
  }

  // ---------------------------------------------------------------- value parsers

  const CUR = '(?<![A-Za-z])(?:RM|MYR|SGD|S\\$|USD|US\\$|HKD|AUD|A\\$|IDR|Rp|PHP|₱|THB|฿|INR|₹|GBP|£|EUR|€|\\$)';
  const NUM = '\\d[\\d,.]*\\s?[kKmM]?(?![A-Za-z])';
  const UNIT =
    '(?:\\s*(?:\\/|per\\s+|a\\s+)\\s*(?:[Mm]onth|[Mm]th|mo|[Yy]ear|yr|[Aa]nnum|[Hh]our|hr|[Dd]ay|[Ww]eek)\\b)?';
  const SALARY_RE = new RegExp(`${CUR}\\s?${NUM}${UNIT}(?:\\s*(?:-|–|—|to)\\s*(?:${CUR})?\\s?${NUM}${UNIT})?`);

  /** "RM 5K/month - RM 7K/month", "MYR 5,000 - 7,000" ... -> the matched text, or ''. */
  function salaryFromText(text) {
    const m = SALARY_RE.exec(String(text || ''));
    return m ? clean(m[0]).replace(/[.,;:\s]+$/, '') : '';
  }

  const EMPLOYMENT_TYPES = [
    [/\bfull[- ]?time\b/i, 'Full-time'],
    [/\bpart[- ]?time\b/i, 'Part-time'],
    [/\bcontract(or)?\b/i, 'Contract'],
    [/\bintern(ship)?\b/i, 'Internship'],
    [/\btemporary\b/i, 'Temporary'],
    [/\bfreelance\b/i, 'Freelance'],
    [/\bcasual\b/i, 'Casual'],
    [/\bvolunteer\b/i, 'Volunteer'],
  ];

  function normalizeEmployment(text) {
    for (const [re, label] of EMPLOYMENT_TYPES) if (re.test(String(text || ''))) return label;
    return '';
  }

  // ---------------------------------------------------------------- layer: JSON-LD

  function findJobPosting(node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = findJobPosting(item);
        if (hit) return hit;
      }
      return null;
    }
    const type = node['@type'];
    if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return node;
    return node['@graph'] ? findJobPosting(node['@graph']) : null;
  }

  const unique = (list) => [...new Set(list.map(clean).filter(Boolean))];
  const num = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : String(n));
  const positive = (n) => (Number(n) > 0 ? n : null); // some sites publish 0 for "unknown"

  function htmlToText(html) {
    if (!html) return '';
    const toLines = (s) => {
      const doc = new DOMParser().parseFromString(s, 'text/html');
      const body = doc.body;
      body.querySelectorAll('br').forEach((el) => el.replaceWith(doc.createTextNode('\n')));
      body.querySelectorAll('li').forEach((el) => el.insertBefore(doc.createTextNode('• '), el.firstChild));
      body.querySelectorAll('p, div, section, article, ul, ol, li, h1, h2, h3, h4').forEach((el) => el.append(doc.createTextNode('\n')));
      return body.textContent || '';
    };
    let text = toLines(String(html));
    if (/<\/?[a-z][^>]*>/i.test(text)) text = toLines(text); // description was HTML-escaped
    return text.replace(/[\t\u00a0 ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function formatSalary(base) {
    if (!base) return '';
    if (typeof base === 'string') return clean(base);
    const value = base.value;
    if (value == null) return '';
    let amount = '';
    let unit = '';
    if (typeof value === 'object') {
      const min = positive(value.minValue);
      const max = positive(value.maxValue);
      const single = positive(value.value);
      if (min != null && max != null && min !== max) amount = `${num(min)} - ${num(max)}`;
      else if (single != null) amount = num(single);
      else if (min != null || max != null) amount = num(min != null ? min : max);
      unit = { HOUR: 'hour', DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' }[String(value.unitText || '').toUpperCase()] || '';
    } else if (positive(value) != null) {
      amount = num(value);
    }
    if (!amount) return '';
    return clean(`${base.currency || ''} ${amount}${unit ? ' / ' + unit : ''}`);
  }

  function formatLocation(posting) {
    const parts = [].concat(posting.jobLocation || []).map((loc) => {
      const a = loc && loc.address;
      if (!a) return '';
      if (typeof a === 'string') return clean(a);
      const country = a.addressCountry && typeof a.addressCountry === 'object' ? a.addressCountry.name : a.addressCountry;
      return unique([a.addressLocality, a.addressRegion, country]).join(', ');
    });
    const joined = unique(parts).join(' / ');
    if (joined) return joined;
    return String(posting.jobLocationType || '').toUpperCase() === 'TELECOMMUTE' ? 'Remote' : '';
  }

  function formatEmployment(value) {
    const labels = [].concat(value || []).map((v) => {
      const key = String(v).toUpperCase().replace(/[\s-]+/g, '_');
      if (key === 'PER_DIEM') return 'Per diem';
      return normalizeEmployment(String(v).replace(/_/g, ' '));
    });
    return unique(labels).join(', ');
  }

  function fromJsonLd(doc) {
    let posting = null;
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        posting = findJobPosting(JSON.parse(script.textContent));
      } catch (_) {
        continue; // malformed JSON-LD is common; skip it
      }
      if (posting) break;
    }
    if (!posting) return {};

    let org = posting.hiringOrganization;
    if (Array.isArray(org)) org = org[0];
    const company = typeof org === 'string' ? org : org && org.name;

    return {
      role: posting.title,
      company,
      salary: formatSalary(posting.baseSalary),
      location: formatLocation(posting),
      employmentType: formatEmployment(posting.employmentType),
      url: typeof posting.url === 'string' ? posting.url : '',
      jobDescription: htmlToText(posting.description),
    };
  }

  // ---------------------------------------------------------------- layer: metadata

  // Titles in <title>/og:title are "Role at Company | Site" in a dozen different shapes,
  // so we don't try to split them. What metadata reliably gives us is the canonical URL.
  function fromMeta(doc, loc) {
    const link = doc.querySelector('link[rel="canonical"]');
    const og = doc.querySelector('meta[property="og:url"]');
    const candidate = (link && link.href) || (og && og.content) || '';
    try {
      if (candidate && new URL(candidate).hostname === loc.hostname) return { url: candidate };
    } catch (_) {
      /* ignore bad URL */
    }
    return {};
  }

  // ---------------------------------------------------------------- layer: semantic DOM

  const LABELS = {
    company: /^(company|employer|hiring organi[sz]ation|organi[sz]ation)$/i,
    location: /^(location|job location|work location)$/i,
    salary: /^(salary|salary range|pay|compensation|remuneration)$/i,
    employmentType: /^(employment type|job type|work type|type of employment|contract type)$/i,
  };

  function valueAfterLabel(el) {
    const next = el.nextElementSibling;
    if (el.tagName === 'DT') return next && next.tagName === 'DD' ? textOf(next) : '';
    return next ? textOf(next) : '';
  }

  /** Finds "Company: Acme", <dt>Company</dt><dd>Acme</dd>, <th>/<td> and label+sibling pairs. */
  function fromLabels(root) {
    const out = {};
    for (const el of root.querySelectorAll('dt, th, label, strong, b, span, div, p, li')) {
      if (el.children.length > 1) continue; // labels are leaf-ish elements
      const own = clean(el.textContent);
      if (!own || own.length > 60) continue;

      const colon = own.indexOf(':');
      const label = colon > 0 ? clean(own.slice(0, colon)) : own;
      const inline = colon > 0 ? clean(own.slice(colon + 1)) : '';

      for (const [field, re] of Object.entries(LABELS)) {
        if (out[field] || !re.test(label)) continue;
        const value = inline || valueAfterLabel(el);
        if (value && value.length <= 200) out[field] = value;
      }
    }
    return out;
  }

  function fromMicrodata(doc) {
    const pick = (selector) => {
      const el = doc.querySelector(selector);
      return el ? clean(el.getAttribute('content') || textOf(el)) : '';
    };
    const location = pick('[itemprop="jobLocation"]');
    return {
      company: pick('[itemprop="hiringOrganization"] [itemprop="name"]') || pick('[itemprop="hiringOrganization"]'),
      location: location.length <= 200 ? location : '',
      employmentType: pick('[itemprop="employmentType"]'),
    };
  }

  function pickHeading(doc) {
    for (const h1 of doc.querySelectorAll('h1')) {
      const text = textOf(h1);
      if (text.length >= 2 && text.length <= 200) return h1;
    }
    return null;
  }

  /** Site-independent guesses based on meaning (h1, labels, microdata) instead of class names. */
  function semanticLayer(doc) {
    const h1 = pickHeading(doc);
    const scope = doc.querySelector('main') || doc.body;
    const labelled = fromLabels(scope);
    const micro = fromMicrodata(doc);
    const regionText = h1 ? spacedText(headerRegion(h1)) : '';

    const employment = micro.employmentType || labelled.employmentType || '';
    return {
      role: h1 ? textOf(h1) : '',
      company: micro.company || labelled.company || '',
      location: micro.location || labelled.location || '',
      salary: labelled.salary || salaryFromText(regionText),
      employmentType: normalizeEmployment(employment) || employment,
    };
  }

  // ---------------------------------------------------------------- merge

  /** Run one layer; a bug or odd DOM in a single layer must never lose the other layers' results. */
  function layer(name, fn) {
    try {
      return { name, data: fn() || {} };
    } catch (_) {
      return { name, data: {} };
    }
  }

  /** layers are in priority order. Returns { fields, sources } where sources says which layer won. */
  function merge(layers) {
    const fields = {};
    const sources = {};
    for (const field of FIELDS) {
      fields[field] = '';
      for (const l of layers) {
        const rawValue = l.data && l.data[field];
        const value = field === 'jobDescription'
          ? String(rawValue == null ? '' : rawValue).replace(/\r\n?/g, '\n').replace(/[\t\u00a0 ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
          : clean(rawValue);
        if (value) {
          fields[field] = value;
          sources[field] = l.name;
          break;
        }
      }
    }
    if (fields.jobDescription.length > MAX_DESCRIPTION) fields.jobDescription = fields.jobDescription.slice(0, MAX_DESCRIPTION);
    return { fields, sources };
  }

  Object.assign(JT, {
    clean, textOf, descriptionOf, spacedText, firstText, fromSelectors, waitFor, headerRegion,
    salaryFromText, normalizeEmployment,
    fromJsonLd, fromMeta, fromLabels, semanticLayer, pickHeading,
    layer, merge,
  });
})();
