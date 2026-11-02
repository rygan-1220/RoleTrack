// Generic URL cleanup for sites without a dedicated extractor.
// LinkedIn / Jobstreet URLs are already canonicalised inside their extractors.

const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|msclkid|mc_[a-z]+|ref|refid|referrer|trk|trackingid|tracking|src|source|campaign)$/i;

/** Drop the #fragment and tracking parameters; keep everything else (some sites use ?id=123). */
export function cleanJobUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol)) return '';
    url.hash = '';
    for (const name of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM.test(name)) url.searchParams.delete(name);
    }
    return url.toString();
  } catch {
    return '';
  }
}
