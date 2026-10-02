// What the user can change about the alerts themselves. Kept deliberately
// small: everything about WHICH calls are worth an alert is decided by the
// deck, which owns the chain and threshold preferences. Two places deciding
// that is two places that can disagree, and the one in the browser is the one
// nobody would think to check.
export const DEFAULTS = { enabled: true, seconds: 15, server: 'http://localhost:5050' };

export async function getSettings() {
  try {
    const got = await chrome.storage.sync.get(DEFAULTS);
    return { ...DEFAULTS, ...got };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function setSettings(patch) {
  try { await chrome.storage.sync.set(patch); } catch { /* storage unavailable */ }
}
