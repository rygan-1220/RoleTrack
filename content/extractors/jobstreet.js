// JobStreet extractor (my.jobstreet.com, sg.jobstreet.com, ...).
//
// JobStreet's pages are built on SEEK's platform, which exposes stable `data-automation`
// attributes (unlike its hashed CSS class names). We rely on those first, then fall back
// to JSON-LD and the generic semantic layer.

(function () {
  const JT = window.JobTracker;

  const SELECTORS = {
    role: ['[data-automation="job-detail-title"]'],
    company: ['[data-automation="advertiser-name"]'],
    location: ['[data-automation="job-detail-location"]'],
    salary: ['[data-automation="job-detail-salary"]'],
    employmentType: ['[data-automation="job-detail-work-type"]'],
    jobDescription: ['[data-automation="jobAdDetails"]'],
  };

  // Job pages are /job/<id>; search pages show the selected job as ?jobId=<id>.
  function canonicalUrl(doc, loc) {
    let id = new URLSearchParams(loc.search).get('jobId') || (/\/job\/(\d+)/.exec(loc.pathname) || [])[1];
    // Recommendation/home pages can show a selected job without changing the page URL.
    // Prefer the title link so we save the actual job instead of the generic JobStreet page.
    if (!id) {
      const titleLink = doc.querySelector('[data-automation="job-detail-title"] a[href]');
      const href = titleLink && titleLink.getAttribute('href');
      const match = href && /\/job\/(\d+)/.exec(href);
      if (match) id = match[1];
    }
    return id && /^\d+$/.test(id) ? `${loc.origin}/job/${id}` : '';
  }

  JT.extractors.jobstreet = {
    name: 'jobstreet',

    async ready(doc) {
      await JT.waitFor(() => doc.querySelector(SELECTORS.role[0]), 3000);
    },

    extract(doc, loc) {
      const dom = JT.layer('jobstreet-dom', () => ({
        ...JT.fromSelectors(doc, SELECTORS),
        jobDescription: JT.descriptionOf(doc.querySelector(SELECTORS.jobDescription[0])),
        url: canonicalUrl(doc, loc),
      }));
      return JT.merge([
        dom,
        JT.layer('json-ld', () => JT.fromJsonLd(doc)),
        JT.layer('page-text', () => JT.semanticLayer(doc)),
        JT.layer('metadata', () => JT.fromMeta(doc, loc)),
      ]);
    },
  };
})();
