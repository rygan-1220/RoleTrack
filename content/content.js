// Entry point, injected last. The side panel calls window.JobTracker.run(platformKey)
// when it opens, changes tabs, navigates to a job, or the user presses Re-scan.

(function () {
  const JT = window.JobTracker;

  JT.run = async function run(platformKey) {
    const extractor = JT.extractors[platformKey] || JT.extractors.generic;
    try {
      if (extractor.ready) await extractor.ready(document, location);
      const { fields, sources } = extractor.extract(document, location);
      return { ok: true, extractor: extractor.name, fields, sources };
    } catch (err) {
      // The panel shows a friendly message; the raw error is only for debugging.
      return { ok: false, extractor: extractor.name, error: String((err && err.message) || err) };
    }
  };
})();
