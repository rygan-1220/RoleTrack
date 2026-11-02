// All local configuration lives here, in chrome.storage.local.
// (Nothing is synced to your Google account, and nothing is hardcoded in source.)

const KEY = 'jobTrackerConfig';

export const DEFAULT_CONFIG = {
  apiUrl: '', // the Apps Script Web App URL, ends with /exec
  apiKey: '', // shared secret, must match the API_KEY script property
};

// Accepts personal URLs (script.google.com/macros/s/<id>/exec) and Google Workspace URLs
// (script.google.com/a/macros/<domain>/s/<id>/exec). Rejects the /dev test URL on purpose.
const API_URL_PATTERN = /^https:\/\/script\.google\.com\/(?:macros\/s|a\/macros\/[^/]+\/s|a\/[^/]+\/macros\/s)\/[\w-]+\/exec$/;

export function isValidApiUrl(url) {
  return API_URL_PATTERN.test(String(url || '').trim());
}

export function isConfigured(config) {
  return isValidApiUrl(config.apiUrl) && Boolean(config.apiKey);
}

export async function getConfig() {
  const stored = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_CONFIG, ...(stored[KEY] || {}) };
}

export async function saveConfig(config) {
  const clean = {
    apiUrl: String(config.apiUrl || '').trim(),
    apiKey: String(config.apiKey || '').trim(),
  };
  await chrome.storage.local.set({ [KEY]: clean });
  return clean;
}
