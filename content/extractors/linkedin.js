// LinkedIn extractor.
//
// LinkedIn's class names change often, so each field tries (1) known class names,
// then (2) structure near the job title (e.g. "the link to /company/... beside the h1"),
// then (3) the shared JSON-LD / semantic layers.
//
// If LinkedIn changes its markup and a field stops being detected, edit the selector
// lists below — that is the only place that should need touching.

(function () {
  const JT = window.JobTracker;

  const TITLE_SELECTORS = [
    '.job-details-jobs-unified-top-card__job-title h1',
    '.job-details-jobs-unified-top-card__job-title',
    '.jobs-unified-top-card__job-title',
    'h1.top-card-layout__title', // logged-out / public job page
    '.top-card-layout__title',
    'h1.t-24',
  ];
  const COMPANY_SELECTORS = [
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name',
    'a.topcard__org-name-link',
    '.topcard__org-name-link',
  ];
  const DESCRIPTION_SELECTORS = [
    '#job-details',
    '.jobs-description__content',
    '.jobs-box__html-content',
    '.show-more-less-html__markup',
    '.description__text',
  ];

  // Job pages: /jobs/view/<id>/ , /jobs/view/<slug>-<id>/ , and search/collections views with ?currentJobId=<id>
  const VIEW_PATH = /\/jobs\/view\/(?:[^/]*-)?(\d{6,})/;

  function jobId(loc) {
    const fromQuery = new URLSearchParams(loc.search).get('currentJobId');
    if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;
    const m = VIEW_PATH.exec(loc.pathname);
    return m ? m[1] : '';
  }

  // One canonical URL per job so duplicate detection works no matter how you reached the listing.
  function canonicalUrl(loc) {
    const id = jobId(loc);
    return id ? `https://www.linkedin.com/jobs/view/${id}/` : '';
  }

  function findTitle(doc, loc) {
    for (const selector of TITLE_SELECTORS) {
      const el = doc.querySelector(selector);
      if (JT.textOf(el)) return el;
    }
    // Class-independent fallback, only on pages that are clearly job pages.
    return jobId(loc) ? doc.querySelector('main h1') : null;
  }

  const firstSegment = (text) => (String(text).split('·')[0] || '').trim();

  function findLocation(doc, region) {
    const publicPage = JT.firstText(doc, ['.topcard__flavor--bullet']);
    if (publicPage) return publicPage;

    const line = JT.firstText(doc, [
      '.job-details-jobs-unified-top-card__primary-description-container',
      '.jobs-unified-top-card__primary-description',
    ]);
    if (line) return firstSegment(line);

    // Class-independent: the "Kuala Lumpur, Malaysia · 2 days ago · 40 applicants" line.
    if (!region) return '';
    const matches = [...region.querySelectorAll('div, p, span')].filter((el) => {
      const t = JT.textOf(el);
      return t.length < 200 && t.includes('·') && /\b(ago|applicants?|reposted|clicked apply|people)\b/i.test(t);
    });
    const innermost = matches.find((el) => !matches.some((other) => other !== el && el.contains(other)));
    return innermost ? firstSegment(JT.textOf(innermost)) : '';
  }

  function fromDom(doc, loc, title, region) {
    const role = JT.textOf(title);

    let company = JT.firstText(doc, COMPANY_SELECTORS);
    if (!company && region) {
      for (const a of region.querySelectorAll('a[href*="/company/"]')) {
        company = JT.textOf(a);
        if (company) break;
      }
    }

    // Salary / job type appear as chips in the header. Remove the title first so a title like
    // "Contract Administrator" doesn't get read as an employment type.
    const headerText = region ? JT.spacedText(region).replace(JT.spacedText(title), ' ') : '';

    return {
      role,
      company,
      location: findLocation(doc, region),
      salary: JT.salaryFromText(headerText),
      employmentType: JT.normalizeEmployment(headerText),
      url: canonicalUrl(loc),
      jobDescription: JT.descriptionOf(doc.querySelector(DESCRIPTION_SELECTORS.join(','))),
    };
  }

  JT.extractors.linkedin = {
    name: 'linkedin',

    // The job pane renders after page load; wait (without polling) for the title.
    async ready(doc, loc) {
      await JT.waitFor(() => findTitle(doc, loc), 3000);
    },

    extract(doc, loc) {
      const title = findTitle(doc, loc);
      const region = title ? JT.headerRegion(title) : null;
      const onJobPage = Boolean(jobId(loc));

      const layers = [JT.layer('linkedin-dom', () => fromDom(doc, loc, title, region))];
      // JSON-LD on a LinkedIn SPA can describe a previously viewed job, so only trust it on a direct job URL.
      if (/\/jobs\/view\//.test(loc.pathname)) layers.push(JT.layer('json-ld', () => JT.fromJsonLd(doc)));
      if (onJobPage) layers.push(JT.layer('page-text', () => JT.semanticLayer(doc)));
      return JT.merge(layers);
    },
  };
})();
