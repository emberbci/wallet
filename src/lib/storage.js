import { STORAGE_KEYS, SESSION_KEY, SESSION_TTL_MS } from "../config.js";

function getChromeStorage() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    throw new Error("Chrome local storage is unavailable in this context.");
  }

  return chrome.storage.local;
}

function readLocalStorage(keys) {
  return new Promise((resolve, reject) => {
    getChromeStorage().get(keys, (result) => {
      if (chrome.runtime?.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(result);
    });
  });
}

function writeLocalStorage(payload) {
  return new Promise((resolve, reject) => {
    getChromeStorage().set(payload, () => {
      if (chrome.runtime?.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve();
    });
  });
}

export async function readWalletBundle() {
  const result = await readLocalStorage([
    STORAGE_KEYS.vault,
    STORAGE_KEYS.vaultMeta,
    STORAGE_KEYS.tokens,
    STORAGE_KEYS.smartWallets,
    STORAGE_KEYS.tokenDiscoveryCursors,
    STORAGE_KEYS.recentRecipients,
  ]);

  return {
    vault: result[STORAGE_KEYS.vault] ?? null,
    vaultMeta: result[STORAGE_KEYS.vaultMeta] ?? null,
    tokens: result[STORAGE_KEYS.tokens] ?? [],
    smartWallets: result[STORAGE_KEYS.smartWallets] ?? [],
    tokenDiscoveryCursors: result[STORAGE_KEYS.tokenDiscoveryCursors] ?? {},
    recentRecipients: Array.isArray(result[STORAGE_KEYS.recentRecipients])
      ? result[STORAGE_KEYS.recentRecipients]
      : [],
  };
}

export async function saveWalletBundle({
  vault,
  vaultMeta,
  tokens,
  smartWallets,
  tokenDiscoveryCursors,
  recentRecipients,
}) {
  await writeLocalStorage({
    [STORAGE_KEYS.vault]: vault,
    [STORAGE_KEYS.vaultMeta]: vaultMeta,
    [STORAGE_KEYS.tokens]: tokens,
    [STORAGE_KEYS.smartWallets]: smartWallets ?? [],
    [STORAGE_KEYS.tokenDiscoveryCursors]: tokenDiscoveryCursors ?? {},
    [STORAGE_KEYS.recentRecipients]: Array.isArray(recentRecipients) ? recentRecipients : [],
  });
}

export async function saveTokens(tokens) {
  await writeLocalStorage({
    [STORAGE_KEYS.tokens]: tokens,
  });
}

export async function saveSmartWallets(smartWallets) {
  await writeLocalStorage({
    [STORAGE_KEYS.smartWallets]: smartWallets,
  });
}

export async function saveTokenDiscoveryCursors(tokenDiscoveryCursors) {
  await writeLocalStorage({
    [STORAGE_KEYS.tokenDiscoveryCursors]: tokenDiscoveryCursors ?? {},
  });
}

export async function saveRecentRecipients(recentRecipients) {
  await writeLocalStorage({
    [STORAGE_KEYS.recentRecipients]: Array.isArray(recentRecipients) ? recentRecipients : [],
  });
}

export async function readDeveloperMode() {
  const result = await readLocalStorage([STORAGE_KEYS.developerMode]);
  return Boolean(result[STORAGE_KEYS.developerMode]);
}

export async function saveDeveloperMode(enabled) {
  await writeLocalStorage({
    [STORAGE_KEYS.developerMode]: Boolean(enabled),
  });
}

// ── Session (auto-lock after 10 min idle) ─────────────────────────────────────

function getChromeSessionStorage() {
  if (typeof chrome === "undefined" || !chrome.storage?.session) {
    return null;
  }
  return chrome.storage.session;
}

export async function saveUnlockSession({ payload, password }) {
  const store = getChromeSessionStorage();
  if (!store) return;
  await new Promise((resolve) => {
    store.set({ [SESSION_KEY]: { payload, password, ts: Date.now() } }, resolve);
  });
}

export async function readUnlockSession() {
  const store = getChromeSessionStorage();
  if (!store) return null;
  const result = await new Promise((resolve) => {
    store.get([SESSION_KEY], resolve);
  });
  const entry = result?.[SESSION_KEY];
  if (!entry || !entry.payload || !entry.password || !entry.ts) return null;
  if (Date.now() - entry.ts > SESSION_TTL_MS) {
    store.remove([SESSION_KEY], () => {});
    return null;
  }
  return { payload: entry.payload, password: entry.password };
}

export async function clearUnlockSession() {
  const store = getChromeSessionStorage();
  if (!store) return;
  await new Promise((resolve) => store.remove([SESSION_KEY], resolve));
}
