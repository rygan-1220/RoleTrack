// Fallback extractor for any site without a dedicated one.
// Order: structured data (JSON-LD JobPosting) -> semantic page text -> metadata.

(function () {
  const JT = window.JobTracker;

  JT.extractors.generic = {
    name: 'generic',

    async ready(doc) {
      // Cheap wait: most pages have an <h1> immediately; SPA pages get up to 1.5s.
      await JT.waitFor(() => doc.querySelector('h1'), 1500);
    },

    extract(doc, loc) {
      return JT.merge([
        JT.layer('json-ld', () => JT.fromJsonLd(doc)),
        JT.layer('page-text', () => JT.semanticLayer(doc)),
        JT.layer('metadata', () => JT.fromMeta(doc, loc)),
      ]);
    },
  };
})();
