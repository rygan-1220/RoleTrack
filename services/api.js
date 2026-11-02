// Everything that talks to the Google Apps Script Web App lives here.
// The popup never calls fetch() itself, and this file knows nothing about the UI.
//
// Every function resolves (never throws) with an object shaped like the backend's response:
//   { success: true,  message, row }
//   { success: false, duplicate: true, duplicateType, message, existingRow, existing }
//   { success: false, code, message }         <- backend error OR a connection problem
// so the caller has one shape to handle.

const TIMEOUT_MS = 25000; // Apps Script cold starts can take several seconds

const MESSAGES = {
  offline: 'You appear to be offline.',
  network: 'Unable to connect to Google Sheets.',
  badResponse:
    'Google Sheets sent an unexpected response. Check that the Web App URL is correct and that access is set to "Anyone".',
};

const failure = (code, message) => ({ success: false, code, message });

/**
 * Two Apps Script quirks shape this request:
 *  1. Web apps cannot read HTTP headers, so the API key travels in the JSON body (not X-API-Key).
 *  2. A "Content-Type: application/json" POST triggers a CORS preflight that Apps Script can't answer.
 *     Sending the same JSON as text/plain is a "simple request", so no preflight happens.
 * The host_permissions in manifest.json let the extension read the response (including Google's
 * redirect to script.googleusercontent.com).
 */
async function call(config, payload) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return failure('offline', MESSAGES.offline);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, apiKey: config.apiKey }),
      redirect: 'follow',
      signal: controller.signal,
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return failure('bad_response', MESSAGES.badResponse); // e.g. a Google sign-in HTML page
    }
    if (!data || typeof data !== 'object' || typeof data.success !== 'boolean') {
      return failure('bad_response', MESSAGES.badResponse);
    }
    return data;
  } catch {
    return failure('network', MESSAGES.network);
  } finally {
    clearTimeout(timer);
  }
}

/** Save a job. Pass { force: true } for "Add anyway" after a duplicate warning. */
export function syncJob(config, job, { force = false } = {}) {
  return call(config, { ...job, ...(force ? { force: true } : {}) });
}

/** Connection + API key check, used by "Test connection" in settings. */
export function pingApi(config) {
  return call(config, { action: 'ping' });
}
