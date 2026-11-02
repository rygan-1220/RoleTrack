// The ONE place that knows which job sites have a dedicated extractor.
//
// To add a site (e.g. Indeed):
//   1. write content/extractors/indeed.js (copy jobstreet.js as a template)
//   2. add one entry to PLATFORMS below
// Nothing else needs to change.

export const PLATFORMS = [
  {
    key: 'linkedin',
    name: 'LinkedIn',
    hostPattern: /(^|\.)linkedin\.com$/i,
    extractor: 'content/extractors/linkedin.js',
  },
  {
    key: 'jobstreet',
    name: 'Jobstreet',
    // my.jobstreet.com, sg.jobstreet.com, jobstreet.com.my, ...
    hostPattern: /(^|\.)jobstreet\.[a-z.]+$/i,
    extractor: 'content/extractors/jobstreet.js',
  },
];

/**
 * Work out which platform a URL belongs to.
 * Unknown sites get key "generic" and their hostname as a suggested platform name.
 */
export function detectPlatform(url) {
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { key: 'generic', name: '', hostname: '', extractor: null };
  }

  const known = PLATFORMS.find((p) => p.hostPattern.test(hostname));
  if (known) return { ...known, hostname };

  return {
    key: 'generic',
    name: hostname.replace(/^www\./, ''),
    hostname,
    extractor: null,
  };
}

/** Files to inject into the page, in order. base.js must come first, content.js last. */
export function scriptsFor(platform) {
  const files = ['content/extractors/base.js'];
  if (platform.extractor) files.push(platform.extractor);
  if (platform.key === 'linkedin' || platform.key === 'jobstreet') files.push('content.js');
  files.push('content/extractors/generic.js', 'content/content.js');
  return files;
}
