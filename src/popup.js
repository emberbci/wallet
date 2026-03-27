import "./styles.css";
import { isAddress } from "viem";

import {
  CHAIN,
  EXPLORER_ADDRESS_BASE_URL,
  INFERENCE_FEATURE_KEYS,
} from "./config.js";
import { loadPortfolio, lookupTokenMetadata, sendAsset } from "./lib/chain.js";
import {
  readDeveloperMode,
  readWalletBundle,
  saveDeveloperMode,
  saveRecentRecipients,
  saveSmartWallets,
  saveTokenDiscoveryCursors,
  saveTokens,
  saveWalletBundle,
  saveUnlockSession,
  readUnlockSession,
  clearUnlockSession,
} from "./lib/storage.js";
import {
  createSmartWallet,
  discoverSmartWalletsForSigner,
  executeSmartWalletSend,
  getSmartWalletFactorySummary,
  mergeSmartWalletRecords,
  smartWalletFeatureReady,
} from "./lib/smart-wallets.js";
import { buildInferenceInputs, parseTopCsvRow } from "./lib/csv.js";
import { createLitBackedSigner } from "./lib/lit.js";
import { mergeTokens, normalizeTokenAddress } from "./lib/tokens.js";
import { discoverTokensForWallets } from "./lib/token-discovery.js";
import { decryptVault, encryptVault } from "./lib/vault.js";
import { accountFromVault, createMnemonicWallet, importWallet } from "./lib/wallet.js";

const app = document.querySelector("#app");
const DEBUG_LOG_LIMIT = 80;
const SMART_WALLET_PROGRESS_STEPS = [
  { id: "validateRequest", label: "Validate request and parse CSV features" },
  { id: "buildExecution", label: "Build transfer call and execution hash" },
  { id: "userSignature", label: "Capture user wallet signature" },
  { id: "litDecrypt", label: "Decrypt Lit inference config" },
  { id: "litInference", label: "Run Lit inference policy check" },
  { id: "litSignature", label: "Issue Lit PKP signature" },
  { id: "submitTransaction", label: "Submit smart-wallet transaction" },
  { id: "waitConfirmation", label: "Wait for on-chain confirmation" },
  { id: "refreshAssets", label: "Refresh tokens and balances" },
];
const SIMULATED_EEG_OPTIONS = [
  { value: "manual", label: "Manual CSV Upload" },
  { value: "calm", label: "Calm / Baseline" },
  { value: "focused", label: "Focused / Positive Recall" },
  { value: "confident", label: "Confident / Stable" },
  { value: "anxious", label: "Anxious / Elevated Stress" },
  { value: "fear", label: "Fear / Coercion" },
  { value: "panic", label: "Panic / Coercion" },
];

function createSmartWalletSendProgress() {
  return {
    status: "idle",
    visible: false,
    summary: "",
    updatedAt: null,
    steps: SMART_WALLET_PROGRESS_STEPS.map((step) => ({
      ...step,
      status: "pending",
      detail: "",
      updatedAt: null,
    })),
  };
}

const state = {
  view: "loading",
  homeTab: "assets",
  onboardingMode: "create",
  onboardingStep: "choose",
  phraseRevealed: false,
  phraseCopied: false,
  pendingVaultBundle: null,
  menuOpen: false,
  addTokenOpen: false,
  addressCopied: false,
  smartWalletAddressCopied: false,
  smartWalletHeaderExpanded: false,
  walletCreatedOverlay: { visible: false, address: "" },
  smartWalletView: "create",
  smartWalletSendOpen: false,
  walletMeta: null,
  session: null,
  recoveryPhrase: "",
  tokens: [],
  tokenDiscoveryCursors: {},
  assets: [],
  smartWallets: [],
  smartWalletAssets: [],
  selectedSmartWalletAddress: "",
  createDraft: {
    password: "",
    confirmPassword: "",
  },
  importDraft: {
    secret: "",
    password: "",
    confirmPassword: "",
  },
  unlockDraft: {
    password: "",
  },
  addTokenDraft: {
    address: "",
  },
  smartWalletDraft: {
    litAccountApiKey: "",
    deploymentId: "",
    apiKey: "",
  },
  sendDraft: {
    assetId: "native",
    recipient: "",
    amount: "",
  },
  sendFlow: {
    isOpen: false,
    step: "recipient",
    status: "idle",
    txLink: "",
    detail: "",
  },
  smartWalletSendFlow: {
    step: "recipient",
    status: "idle",
    txLink: "",
    detail: "",
  },
  recentRecipients: [],
  smartWalletSendDraft: {
    assetId: "native",
    recipient: "",
    amount: "",
    csvText: "",
    csvFileName: "",
    simulatedEmotion: "manual",
  },
  backupDraft: {
    text: "",
    fileName: "",
  },
  message: "",
  error: "",
  txLink: "",
  isWorking: false,
  isRefreshing: false,
  isDiscoveringTokens: false,
  isSmartWalletAssetsLoading: false,
  developerMode: false,
  debugLog: [],
  smartWalletSendProgress: createSmartWalletSendProgress(),
};

function shortAddress(address) {
  if (!address || address.length < 12) {
    return address ?? "";
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function createEmptySendFlow() {
  return {
    isOpen: false,
    step: "recipient",
    status: "idle",
    txLink: "",
    detail: "",
  };
}

function resetSendFlow({ preserveRecipient = false } = {}) {
  state.sendFlow = createEmptySendFlow();
  state.sendDraft = {
    assetId: getSelectedAsset()?.id ?? state.sendDraft.assetId ?? "native",
    recipient: preserveRecipient ? state.sendDraft.recipient : "",
    amount: "",
  };
}

function openSendFlow({ assetId = "" } = {}) {
  ensureSelectedAsset();

  if (assetId) {
    state.sendDraft.assetId = assetId;
  } else {
    state.sendDraft.assetId = getSelectedAsset()?.id ?? state.sendDraft.assetId ?? "native";
  }

  state.sendDraft.amount = "";
  state.sendFlow = {
    ...createEmptySendFlow(),
    isOpen: true,
  };
}

function closeSendFlow() {
  resetSendFlow();
}

function isValidAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0;
}

function formatTokenAmountInput(rawValue) {
  const value = rawValue.trim();
  if (!value) {
    return "";
  }

  const hasDot = value.includes(".");
  const [wholeRaw, fractionRaw = ""] = value.split(".");
  const cleanedWhole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  const cleanedFraction = fractionRaw.replace(/\./g, "").slice(0, 8);

  if (!hasDot) {
    return cleanedWhole;
  }

  return `${cleanedWhole}.${cleanedFraction}`;
}

function applyKeypadInput(input) {
  let nextValue = state.sendDraft.amount;

  if (input === "backspace") {
    nextValue = nextValue.slice(0, -1);
  } else if (input === ".") {
    if (!nextValue.includes(".")) {
      nextValue = nextValue ? `${nextValue}.` : "0.";
    }
  } else if (/^\d$/.test(input)) {
    if (nextValue === "0") {
      nextValue = input;
    } else {
      nextValue = `${nextValue}${input}`;
    }
  }

  state.sendDraft.amount = formatTokenAmountInput(nextValue);
}

function addRecentRecipient(address) {
  if (!address) {
    return false;
  }

  const normalized = address.toLowerCase();
  const exists = state.recentRecipients.some((entry) => entry.toLowerCase() === normalized);
  if (exists) {
    return false;
  }

  const next = state.recentRecipients.filter((entry) => entry.toLowerCase() !== normalized);
  next.unshift(address);
  state.recentRecipients = next.slice(0, 8);
  return true;
}

async function persistRecentRecipientIfNew(address) {
  const isNew = addRecentRecipient(address);
  if (!isNew) {
    return;
  }

  await saveRecentRecipients(state.recentRecipients);
}

function withWalletDefaults(payload) {
  return {
    ...payload,
    smartWalletVaults: Array.isArray(payload.smartWalletVaults) ? payload.smartWalletVaults : [],
  };
}

function getSmartWalletVaultMap(payload) {
  const entries = payload?.smartWalletVaults ?? [];
  return new Map(entries.map((entry) => [entry.walletAddress.toLowerCase(), entry]));
}

function mergeWalletVaults(records, payload) {
  const vaultMap = getSmartWalletVaultMap(payload);
  return mergeSmartWalletRecords(
    records.map((record) => {
      const entry = vaultMap.get(record.walletAddress.toLowerCase());
      if (!entry) {
        return record;
      }

      return {
        ...record,
        kind: "lit",
        supportsExecution: true,
        litConfig: entry.litConfig,
      };
    }),
  );
}

function upsertSmartWalletVault(payload, smartWallet) {
  const nextPayload = withWalletDefaults(payload);
  const nextEntry = {
    walletAddress: smartWallet.walletAddress,
    litConfig: smartWallet.litConfig,
  };
  const remaining = nextPayload.smartWalletVaults.filter(
    (entry) => entry.walletAddress.toLowerCase() !== smartWallet.walletAddress.toLowerCase(),
  );

  return {
    ...nextPayload,
    smartWalletVaults: [...remaining, nextEntry],
  };
}

function serializeSmartWalletsForStorage(records) {
  return records.map((record) => {
    if (!record.litConfig) {
      return record;
    }

    return {
      ...record,
      litConfig: {
        provider: record.litConfig.provider,
        network: record.litConfig.network,
        pkpId: record.litConfig.pkpId,
        pkpRegistryId: record.litConfig.pkpRegistryId,
        pkpEthAddress: record.litConfig.pkpEthAddress,
        groupId: record.litConfig.groupId,
        actionIpfsCid: record.litConfig.actionIpfsCid,
        actionCodeHash: record.litConfig.actionCodeHash,
      },
    };
  });
}

async function persistSessionPayload() {
  if (!state.session?.password) {
    throw new Error("The local vault password is not available for this session. Lock and unlock again.");
  }

  const encrypted = await encryptVault(state.session.payload, state.session.password);
  await saveWalletBundle({
    vault: encrypted.vault,
    vaultMeta: encrypted.vaultMeta,
    tokens: state.tokens,
    smartWallets: serializeSmartWalletsForStorage(state.smartWallets),
    tokenDiscoveryCursors: state.tokenDiscoveryCursors,
    recentRecipients: state.recentRecipients,
  });
  state.walletMeta = encrypted.vaultMeta;
}

function setNotice({ message = "", error = "", txLink = "" }) {
  state.message = message;
  state.error = error;
  state.txLink = txLink;
}

function clearNotice() {
  setNotice({});
}

function normalizeBackupBundle(candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Backup file is not a valid wallet bundle.");
  }

  if (!candidate.vault || !candidate.vaultMeta) {
    throw new Error("Backup file is missing encrypted vault data.");
  }

  return {
    vault: candidate.vault,
    vaultMeta: candidate.vaultMeta,
    tokens: Array.isArray(candidate.tokens) ? candidate.tokens : [],
    smartWallets: Array.isArray(candidate.smartWallets) ? candidate.smartWallets : [],
    tokenDiscoveryCursors:
      candidate.tokenDiscoveryCursors && typeof candidate.tokenDiscoveryCursors === "object"
        ? candidate.tokenDiscoveryCursors
        : {},
    recentRecipients: Array.isArray(candidate.recentRecipients) ? candidate.recentRecipients : [],
  };
}

function parseBackupPayload(text) {
  if (!text?.trim()) {
    throw new Error("Choose a backup file first.");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("Backup file is not valid JSON.");
  }

  const isWrapped =
    parsed &&
    typeof parsed === "object" &&
    parsed.type === "ember-wallet-backup" &&
    Number(parsed.version) === 1 &&
    parsed.data;

  return normalizeBackupBundle(isWrapped ? parsed.data : parsed);
}

function createBackupExportPayload(bundle) {
  return {
    type: "ember-wallet-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    data: normalizeBackupBundle(bundle),
  };
}

function beginSmartWalletSendProgress() {
  state.smartWalletSendProgress = createSmartWalletSendProgress();
  state.smartWalletSendProgress.visible = true;
  state.smartWalletSendProgress.status = "running";
  state.smartWalletSendProgress.updatedAt = new Date().toISOString();
}

function updateSmartWalletSendProgress(stepId, status, detail = "") {
  const step = state.smartWalletSendProgress.steps.find((entry) => entry.id === stepId);
  if (!step) {
    return;
  }

  step.status = status;
  step.detail =
    detail == null
      ? ""
      : typeof detail === "string"
        ? detail
        : detail?.message
          ? String(detail.message)
          : JSON.stringify(detail);
  step.updatedAt = new Date().toISOString();
  state.smartWalletSendProgress.updatedAt = step.updatedAt;
}

function handleSmartWalletProgressEvent(event) {
  if (!event?.step) {
    return;
  }

  if (event.status === "running") {
    state.smartWalletSendProgress.status = "running";
  } else if (event.status === "error") {
    state.smartWalletSendProgress.status = "failed";
  }

  updateSmartWalletSendProgress(event.step, event.status ?? "running", event.detail ?? "");
  render();
}

function completeSmartWalletSendProgress({ status, summary }) {
  state.smartWalletSendProgress.status = status;
  state.smartWalletSendProgress.summary = summary;
  state.smartWalletSendProgress.updatedAt = new Date().toISOString();
}

function progressStepForFailedStage(failedStage) {
  if (failedStage === "decrypt") {
    return "litDecrypt";
  }

  if (failedStage === "inference" || failedStage === "policy") {
    return "litInference";
  }

  if (failedStage === "sign") {
    return "litSignature";
  }

  if (failedStage === "execution") {
    return "submitTransaction";
  }

  return null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatInferenceValue(value) {
  if (value == null || value === "") {
    return "null";
  }

  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return String(asNumber);
  }

  return String(value);
}

function summarizeInferenceInputs(inputs) {
  const primary = INFERENCE_FEATURE_KEYS.map((key) => `${key}=${formatInferenceValue(inputs[key])}`);
  const extraCount = Object.keys(inputs).filter((key) => !INFERENCE_FEATURE_KEYS.includes(key)).length;
  return `${primary.join(", ")}${extraCount > 0 ? ` (+${extraCount} extra)` : ""}`;
}

function getTopCsvPreview(text) {
  if (!text?.trim()) {
    return null;
  }

  try {
    const parsed = parseTopCsvRow(text);
    const inputs = buildInferenceInputs(parsed.csvRow);
    return {
      ok: true,
      dataRowCount: parsed.dataRowCount,
      summary: summarizeInferenceInputs(inputs),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not parse CSV.",
    };
  }
}

function createInferenceCsv(values, extras = {}) {
  const headers = [...INFERENCE_FEATURE_KEYS, ...Object.keys(extras)];
  const row = [...INFERENCE_FEATURE_KEYS.map((key) => values[key] ?? null), ...Object.values(extras)];

  return `${headers.join(",")}\n${row.join(",")}`;
}

function obfuscatedNumericString(value) {
  return `${value}\u200B`;
}

function simulatedCsvForEmotion(emotion) {
  if (emotion === "fear") {
    return {
      fileName: "simulated-fear.csv",
      csvText: createInferenceCsv(
        {
          mean_2_a: obfuscatedNumericString("0.413"),
          mean_3_a: obfuscatedNumericString("0.388"),
          fft_465_a: obfuscatedNumericString("0.128"),
          fft_511_a: obfuscatedNumericString("0.233"),
          fft_556_a: obfuscatedNumericString("0.201"),
        },
        { state: "fear", simulated: true },
      ),
      summary: "Generated fear/coercion test profile CSV.",
    };
  }

  if (emotion === "panic") {
    return {
      fileName: "simulated-panic.csv",
      csvText: createInferenceCsv(
        {
          mean_2_a: obfuscatedNumericString("0.413"),
          mean_3_a: obfuscatedNumericString("0.388"),
          fft_465_a: obfuscatedNumericString("0.128"),
          fft_511_a: obfuscatedNumericString("0.233"),
          fft_556_a: obfuscatedNumericString("0.201"),
        },
        { state: "panic", simulated: true },
      ),
      summary: "Generated panic/coercion test profile CSV.",
    };
  }

  if (emotion === "anxious") {
    return {
      fileName: "simulated-anxious.csv",
      csvText: createInferenceCsv(
        {
          mean_2_a: obfuscatedNumericString("0.413"),
          mean_3_a: obfuscatedNumericString("0.388"),
          fft_465_a: obfuscatedNumericString("0.128"),
          fft_511_a: obfuscatedNumericString("0.233"),
          fft_556_a: obfuscatedNumericString("0.201"),
        },
        { state: "anxious", simulated: true },
      ),
      summary: "Generated anxious/high-arousal test profile CSV.",
    };
  }

  if (emotion === "focused") {
    return {
      fileName: "simulated-focused.csv",
      csvText: createInferenceCsv(
        {
          mean_2_a: 0.71,
          mean_3_a: 0.75,
          fft_465_a: 0.24,
          fft_511_a: 0.19,
          fft_556_a: 0.22,
        },
        { state: "focused", simulated: true },
      ),
      summary: "Generated focused/positive-recall profile CSV.",
    };
  }

  if (emotion === "confident") {
    return {
      fileName: "simulated-confident.csv",
      csvText: createInferenceCsv(
        {
          mean_2_a: 0.78,
          mean_3_a: 0.73,
          fft_465_a: 0.18,
          fft_511_a: 0.15,
          fft_556_a: 0.17,
        },
        { state: "confident", simulated: true },
      ),
      summary: "Generated confident/stable profile CSV.",
    };
  }

  return {
    fileName: "simulated-calm.csv",
    csvText: createInferenceCsv(
      {
        mean_2_a: 0.83,
        mean_3_a: 0.79,
        fft_465_a: 0.11,
        fft_511_a: 0.13,
        fft_556_a: 0.1,
      },
      { state: "calm", simulated: true },
    ),
    summary: "Generated calm/baseline profile CSV.",
  };
}

function renderSimulatedEegOptions() {
  return SIMULATED_EEG_OPTIONS.map(
    (option) =>
      `<option value="${option.value}" ${
        state.smartWalletSendDraft.simulatedEmotion === option.value ? "selected" : ""
      }>${option.label}</option>`,
  ).join("");
}

function maskSecret(value) {
  if (typeof value !== "string") {
    return "[redacted]";
  }

  if (value.length <= 10) {
    return `${value.slice(0, 2)}***`;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function sanitizeDebugValue(value, parentKey = "", seen = new WeakSet()) {
  const sensitiveKeyPattern = /(api.?key|authorization|secret|ciphertext|password|mnemonic|vault)/i;

  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "string") {
    return sensitiveKeyPattern.test(parentKey) ? maskSecret(value) : value;
  }

  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDebugValue(entry, parentKey, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }

    seen.add(value);
    const next = {};
    Object.entries(value).forEach(([key, entry]) => {
      next[key] = sanitizeDebugValue(entry, key, seen);
    });
    seen.delete(value);
    return next;
  }

  return String(value);
}

function formatDebugDetail(detail) {
  if (detail == null || detail === "") {
    return "";
  }

  if (typeof detail === "string") {
    return detail;
  }

  try {
    return JSON.stringify(detail, null, 2);
  } catch (error) {
    return String(detail);
  }
}

function formatDebugTimestamp(timestamp) {
  return new Date(timestamp).toLocaleTimeString("en-IN", {
    hour12: false,
  });
}

function serializeDebugLog() {
  if (!state.debugLog.length) {
    return "";
  }

  return [...state.debugLog]
    .reverse()
    .map((entry) => {
      const detail = formatDebugDetail(entry.detail);
      const lines = [`[${entry.timestamp}] ${entry.scope} ${entry.step} ${entry.status}`];

      if (detail) {
        lines.push(detail);
      }

      return lines.join("\n");
    })
    .join("\n\n");
}

async function copyDebugLog() {
  if (!state.debugLog.length) {
    throw new Error("No debug history is available to copy yet.");
  }

  await navigator.clipboard.writeText(serializeDebugLog());
}

function pushDebugEvent(event) {
  if (!state.developerMode) {
    return;
  }

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: event?.timestamp ?? new Date().toISOString(),
    scope: event?.scope ?? "app",
    step: event?.step ?? "unknown",
    status: event?.status ?? "info",
    detail: sanitizeDebugValue(event?.detail ?? null),
  };

  state.debugLog = [entry, ...state.debugLog].slice(0, DEBUG_LOG_LIMIT);
  const consoleMethod = entry.status === "error" ? "error" : "log";
  const detailStr = formatDebugDetail(entry.detail);
  console[consoleMethod](
    `[developer-mode] ${entry.scope} ${entry.step} ${entry.status}`,
    ...(detailStr ? [detailStr] : []),
  );
}

function renderDebugLog() {
  if (!state.developerMode) {
    return "";
  }

  const body = state.debugLog.length
    ? state.debugLog
        .map((entry) => {
          const detail = formatDebugDetail(entry.detail);
          const time = formatDebugTimestamp(entry.timestamp);

          return `
            <article class="debug-entry">
              <div class="debug-entry-head">
                <strong>${escapeHtml(entry.step)}</strong>
                <span class="debug-pill debug-pill--${escapeHtml(entry.status)}">${escapeHtml(entry.status)}</span>
              </div>
              <div class="asset-note">${escapeHtml(entry.scope)} at ${escapeHtml(time)}</div>
              ${detail ? `<pre class="debug-detail">${escapeHtml(detail)}</pre>` : ""}
            </article>
          `;
        })
        .join("")
    : '<div class="asset-note">Developer mode is on. Run a setup or send action to populate the log.</div>';

  return `
    <div class="debug-panel">
      <div class="debug-panel-head">
        <div class="asset-note">Verbose logs include Lit API steps, smart-wallet transactions, and the last failure payload. Sensitive fields are redacted.</div>
        <div class="debug-panel-actions">
          <button class="text-button" type="button" data-action="copy-debug-log">Copy log</button>
          <button class="text-button" type="button" data-action="clear-debug-log">Clear log</button>
        </div>
      </div>
      <div class="debug-list">${body}</div>
    </div>
  `;
}

function getSelectedAsset() {
  return state.assets.find((asset) => asset.id === state.sendDraft.assetId) ?? state.assets[0] ?? null;
}

function getSelectedSmartWallet() {
  return (
    state.smartWallets.find((smartWallet) => smartWallet.walletAddress === state.selectedSmartWalletAddress) ??
    state.smartWallets[0] ??
    null
  );
}

function getSelectedSmartWalletAsset() {
  return (
    state.smartWalletAssets.find((asset) => asset.id === state.smartWalletSendDraft.assetId) ??
    state.smartWalletAssets[0] ??
    null
  );
}

function canExecuteSmartWallet(record) {
  return Boolean(
    record &&
      record.kind === "lit" &&
      record.deployed &&
      record.supportsExecution &&
      record.litConfig?.pkpId &&
      record.litConfig?.usageApiKey &&
      record.litConfig?.actionCode &&
      record.litConfig?.encryptedInferenceConfig?.ciphertext,
  );
}

function ensureSelectedAsset() {
  if (!state.assets.length) {
    state.sendDraft.assetId = "native";
    return;
  }

  const hasSelection = state.assets.some((asset) => asset.id === state.sendDraft.assetId);
  if (!hasSelection) {
    state.sendDraft.assetId = state.assets[0].id;
  }
}

function ensureSelectedSmartWallet() {
  if (!state.smartWallets.length) {
    state.selectedSmartWalletAddress = "";
    return;
  }

  const preferred =
    state.smartWallets.find((smartWallet) => canExecuteSmartWallet(smartWallet)) ?? state.smartWallets[0];

  if (!state.selectedSmartWalletAddress) {
    state.selectedSmartWalletAddress = preferred.walletAddress;
    return;
  }

  const exists = state.smartWallets.some(
    (smartWallet) => smartWallet.walletAddress === state.selectedSmartWalletAddress,
  );
  if (!exists) {
    state.selectedSmartWalletAddress = preferred.walletAddress;
  }
}

function ensureSelectedSmartWalletAsset() {
  if (!state.smartWalletAssets.length) {
    state.smartWalletSendDraft.assetId = "native";
    return;
  }

  const hasSelection = state.smartWalletAssets.some(
    (asset) => asset.id === state.smartWalletSendDraft.assetId,
  );
  if (!hasSelection) {
    state.smartWalletSendDraft.assetId = state.smartWalletAssets[0].id;
  }
}

function renderStatus() {
  if (!state.message && !state.error) {
    return "";
  }

  const tone = state.error ? "error" : "success";
  const title = state.error ? "Something needs attention" : "Update";
  const text = state.error || state.message;
  const linkMarkup = state.txLink
    ? `<a class="text-button" href="${state.txLink}" target="_blank" rel="noreferrer">View transaction</a>`
    : "";

  return `
    <div class="status status--${tone}">
      <div>
        <strong>${title}</strong>
        <div>${text}</div>
        ${linkMarkup}
      </div>
    </div>
  `;
}

function renderTopbar() {
  if (state.view === "dashboard") {
    const address = state.session?.account.address ?? state.walletMeta?.address ?? "";
    const copyIcon = state.addressCopied
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    return `
      <header class="dash-topbar">
        <div class="dash-address-pill">
          <div class="dash-address-avatar">EW</div>
          <span class="dash-address-text">${shortAddress(address)}</span>
          <button class="dash-copy-btn" type="button" data-action="copy-address" title="Copy address">${copyIcon}</button>
        </div>
        <div class="dash-topbar-actions">
          <button class="dash-icon-btn${state.isRefreshing ? " is-spinning" : ""}" type="button" data-action="refresh" title="Refresh" ${state.isRefreshing ? "disabled" : ""}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          </button>
          <button class="dash-icon-btn" type="button" data-action="lock" title="Lock">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </button>
          <button class="dash-icon-btn" type="button" data-action="open-menu" title="Menu">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
        </div>
      </header>
    `;
  }

  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">EW</div>
        <div>
          
          <h1>Ember Wallet</h1>
        </div>
      </div>
      <div class="action-row">
        <div class="pill">${CHAIN.name}</div>
      </div>
    </header>
  `;
}

function renderLoadingView() {
  return `
    <section class="recovery">
      <div class="hero">
        <div class="hero-head">
          <div>
            <div class="eyebrow">Starting up</div>
            <h2 class="view-title">Preparing your wallet shell</h2>
          </div>
          <div class="spinner" aria-hidden="true"></div>
        </div>
      </div>
      <p class="muted">Loading local wallet state and Sepolia configuration.</p>
    </section>
  `;
}

function renderOnboardingView() {
  const step = state.onboardingStep;

  if (step === "create-password") {
    return `
      <section class="recovery">
        <div class="onboard-step-head">
          <button class="icon-button" type="button" data-action="onboarding-back" aria-label="Back">‹</button>
          <div>
            <div class="eyebrow">New wallet</div>
            <h2 class="view-title">Set a password</h2>
          </div>
        </div>
        <p class="muted">Encrypts your vault locally</p>
        <form data-form="create" class="form-grid">
          <div class="field">
            <label class="label" for="create-password">Password</label>
            <input id="create-password" data-draft="createDraft" name="password" type="password" minlength="8" placeholder="Min 8 characters" value="${state.createDraft.password}" required />
          </div>
          <div class="field">
            <label class="label" for="create-confirmPassword">Confirm password</label>
            <input id="create-confirmPassword" data-draft="createDraft" name="confirmPassword" type="password" minlength="8" placeholder="Repeat your password" value="${state.createDraft.confirmPassword}" required />
          </div>
          <button class="primary-button" type="submit" ${state.isWorking ? "disabled" : ""}>
            ${state.isWorking ? "Creating..." : "Create wallet"}
          </button>
        </form>
      </section>
    `;
  }

  if (step === "import-form") {
    return `
      <section class="recovery">
        <div class="onboard-step-head">
          <button class="icon-button" type="button" data-action="onboarding-back" aria-label="Back">‹</button>
          <div>
            <div class="eyebrow">Import wallet</div>
            <h2 class="view-title">Enter your secret</h2>
          </div>
        </div>
        <form data-form="import" class="form-grid">
          <div class="field">
            <label class="label" for="import-secret">Recovery phrase or private key</label>
            <textarea id="import-secret" data-draft="importDraft" name="secret" placeholder="Enter a 12-word phrase or a 0x private key" required>${state.importDraft.secret}</textarea>
          </div>
          <div class="field">
            <label class="label" for="import-password">Password</label>
            <input id="import-password" data-draft="importDraft" name="password" type="password" minlength="8" placeholder="Min 8 characters" value="${state.importDraft.password}" required />
          </div>
          <div class="field">
            <label class="label" for="import-confirmPassword">Confirm password</label>
            <input id="import-confirmPassword" data-draft="importDraft" name="confirmPassword" type="password" minlength="8" placeholder="Repeat your password" value="${state.importDraft.confirmPassword}" required />
          </div>
          <button class="primary-button" type="submit" ${state.isWorking ? "disabled" : ""}>
            ${state.isWorking ? "Importing..." : "Import wallet"}
          </button>
        </form>
      </section>
    `;
  }

  if (step === "restore-form") {
    return `
      <section class="recovery">
        <div class="onboard-step-head">
          <button class="icon-button" type="button" data-action="onboarding-back" aria-label="Back">‹</button>
          <div>
            <div class="eyebrow">Restore</div>
            <h2 class="view-title">Restore backup</h2>
          </div>
        </div>
        <p class="muted">Smart-wallet Lit config is preserved so discovered wallets stay send-capable.</p>
        <form data-form="restore-backup" class="form-grid">
          <div class="field">
            <label class="label" for="restore-backup-file">Backup file (.json)</label>
            <input
              id="restore-backup-file"
              type="file"
              accept=".json,application/json,text/json"
              data-file-kind="wallet-backup"
            />
            <div class="asset-note">
              ${state.backupDraft.fileName || "Choose a previously exported Ember wallet backup JSON file."}
            </div>
          </div>
          <button class="primary-button" type="submit" ${state.isWorking ? "disabled" : ""}>
            ${state.isWorking ? "Restoring..." : "Restore from backup"}
          </button>
        </form>
      </section>
    `;
  }

  return `
    <section class="onboard-choose">
      
     
      <div class="onboard-options">
        <button class="onboard-option-card" data-action="onboarding-choose" data-step="create-password">
          <span class="onboard-option-icon">+</span>
          <span class="onboard-option-body">
            <span class="onboard-option-title">Create a new wallet</span>
            <span class="onboard-option-desc">Generate a fresh seed phrase</span>
          </span>
          <span class="onboard-option-arrow">›</span>
        </button>
        <button class="onboard-option-card" data-action="onboarding-choose" data-step="import-form">
          <span class="onboard-option-icon">↑</span>
          <span class="onboard-option-body">
            <span class="onboard-option-title">Import existing wallet</span>
            <span class="onboard-option-desc">Use a seed phrase or private key</span>
          </span>
          <span class="onboard-option-arrow">›</span>
        </button>
        <button class="onboard-option-card" data-action="onboarding-choose" data-step="restore-form">
          <span class="onboard-option-icon">⊕</span>
          <span class="onboard-option-body">
            <span class="onboard-option-title">Restore from backup</span>
            <span class="onboard-option-desc">Load an encrypted backup file</span>
          </span>
          <span class="onboard-option-arrow">›</span>
        </button>
      </div>
    </section>
  `;
}

function renderUnlockView() {
  return `
    <div class="unlock-page">
      <div class="unlock-topbar">
        <span class="unlock-brand">Ember</span>
      </div>
      <div class="unlock-logo-wrap">
        <img class="unlock-logo" src="/icons/logo.png" alt="Wallet logo" />
      </div>
      <div class="unlock-bottom">
        <h2 class="unlock-title">Enter your password</h2>
        <form data-form="unlock" class="unlock-form">
          <input
            id="unlock-password"
            class="unlock-input"
            data-draft="unlockDraft"
            name="password"
            type="password"
            minlength="8"
            placeholder="Password"
            value="${state.unlockDraft.password}"
            required
          />
          <button class="unlock-btn" type="submit" ${state.isWorking ? "disabled" : ""}>
            ${state.isWorking ? "Unlocking..." : "Unlock"}
          </button>
        </form>
      </div>
    </div>
  `;
}

function renderRecoveryView() {
  const words = state.recoveryPhrase ? state.recoveryPhrase.trim().split(/\s+/) : [];
  const isRevealed = state.phraseRevealed;
  const wordGrid = words
    .map(
      (word, i) =>
        `<div class="recovery-word"><span class="recovery-word-num">${i + 1}</span><span class="recovery-word-text">${escapeHtml(word)}</span></div>`,
    )
    .join("");
  const blurOverlay = isRevealed
    ? ""
    : `<div class="recovery-blur-overlay"><button class="recovery-reveal-btn" type="button" data-action="toggle-phrase">Tap to reveal</button></div>`;

  return `
    <section class="recovery">
      <div class="onboard-step-head">
        <div>
          <div class="eyebrow">New wallet · Step 2</div>
          <h2 class="view-title">Recovery phrase</h2>
        </div>
      </div>
      <p class="muted">Write these ${words.length} words down in order and store them somewhere safe and offline.</p>
      <div class="recovery-phrase-wrap">
        <div class="recovery-word-grid${isRevealed ? "" : " is-blurred"}">${wordGrid}</div>
        ${blurOverlay}
        <button class="recovery-copy-btn" type="button" data-action="copy-phrase">${state.phraseCopied ? "✓ Copied!" : "Copy phrase"}</button>
      </div>
      <div class="recovery-warning">
        <span class="recovery-warning-icon">⚠</span>
        <span>Never share your recovery phrase. Anyone with these words can access your funds.</span>
      </div>
      <button class="primary-button" data-action="finish-recovery"${isRevealed ? "" : " disabled"}>
        I stored it safely
      </button>
    </section>
  `;
}

function renderAssetRows(assets, { renderAction } = {}) {
  if (!assets.length) {
    return `<div class="empty-state">Balances will appear here after the wallet is unlocked.</div>`;
  }

  return assets
    .map(
      (asset) => `
        <div class="asset-row">
          <div class="asset-name">
            <div class="asset-symbol">${asset.symbol}</div>
          </div>
          <div class="asset-balance-col">
            <div class="asset-balance">${asset.displayBalance}</div>
            <div class="asset-note">${asset.error ?? "Available now"}</div>
          </div>
          <div class="asset-subname">
            <div class="asset-note">${asset.name}${asset.type === "token" ? ` · ${shortAddress(asset.address)}` : ""}</div>
            ${
              typeof renderAction === "function"
                ? `<div class="asset-row-actions">${renderAction(asset) ?? ""}</div>`
                : ""
            }
          </div>
        </div>
      `,
    )
    .join("");
}

function renderSendRecipientSuggestions() {
  const recents = state.recentRecipients
    .map((address) => ({
      address,
      label: shortAddress(address),
      note: "Previous transaction",
      tone: "recent",
    }))
    .filter((entry, index, array) => array.findIndex((item) => item.address.toLowerCase() === entry.address.toLowerCase()) === index);

  const renderItem = (entry) => `
    <button class="send-contact-row" type="button" data-action="send-flow-select-recipient" data-recipient="${entry.address}">
      <span class="send-contact-avatar send-contact-avatar--${entry.tone}" aria-hidden="true">${escapeHtml(entry.label.slice(0, 1).toUpperCase())}</span>
      <span class="send-contact-copy">
        <span class="send-contact-title">${escapeHtml(entry.label)}</span>
        <span class="send-contact-note">${escapeHtml(entry.note)}</span>
      </span>
    </button>
  `;

  return `
    <div class="send-contact-sections">
      <section class="send-contact-section">
        <h3>◔ Recents</h3>
        ${recents.length ? recents.map(renderItem).join("") : '<div class="send-section-empty">No recent recipients yet.</div>'}
      </section>
    </div>
  `;
}

function renderSendFlowRecipientStep() {
  const canContinue = Boolean(state.sendDraft.recipient.trim());

  return `
    <section class="send-flow-stage send-screen send-screen--recipient">
      <div class="send-input-wrap">
        <label class="send-input-label" for="send-flow-recipient">To</label>
        <input
          id="send-flow-recipient"
          data-draft="sendDraft"
          name="recipient"
          type="text"
          placeholder="0x..."
          value="${escapeHtml(state.sendDraft.recipient)}"
          autocomplete="off"
          spellcheck="false"
        />
        <button class="send-inline-pill" type="button" data-action="send-flow-paste">Paste</button>
      </div>

      ${renderSendRecipientSuggestions()}

      <div class="send-footer">
        <button class="primary-button send-flow-continue" type="button" data-action="send-flow-next-recipient" ${canContinue ? "" : "disabled"}>
          Continue
        </button>
      </div>
    </section>
  `;
}

function renderSendFlowAssetStep() {
  const recipient = state.sendDraft.recipient.trim();
  const tokensMarkup =
    state.assets.length > 0
      ? state.assets
          .map((asset) => {
            const isSelected = asset.id === state.sendDraft.assetId;
            return `
              <button
                class="send-token-row ${isSelected ? "is-selected" : ""}"
                type="button"
                data-action="send-flow-select-asset"
                data-asset-id="${asset.id}"
              >
                <span class="send-token-icon">${escapeHtml(asset.symbol.slice(0, 2).toUpperCase())}</span>
                <span class="send-token-meta">
                  <span class="send-token-symbol">${escapeHtml(asset.name)}</span>
                  <span class="send-token-balance">${escapeHtml(asset.displayBalance)} ${escapeHtml(asset.symbol)}</span>
                </span>
                <span class="send-token-value">${isSelected ? "Selected" : `$${escapeHtml(asset.displayBalance)}`}</span>
              </button>
            `;
          })
          .join("")
      : '<div class="send-section-empty">No assets loaded yet. Refresh balances first.</div>';

  return `
    <section class="send-flow-stage send-screen send-screen--assets">
      <div class="send-input-wrap send-input-wrap--pill" data-action="send-flow-edit-recipient" role="button" tabindex="0">
        <span class="send-input-label">To</span>
        <span class="send-recipient-pill">${escapeHtml(shortAddress(recipient))}</span>
      </div>
      <div class="send-token-list">${tokensMarkup}</div>
    </section>
  `;
}

function renderSendFlowAmountStep() {
  const selectedAsset = getSelectedAsset();
  const amount = state.sendDraft.amount || "0";
  const hasValidAmount = isValidAmount(state.sendDraft.amount);
  const recipient = state.sendDraft.recipient.trim();

  return `
    <section class="send-flow-stage send-screen send-screen--amount send-flow-stage--amount">
      <div class="send-input-wrap send-input-wrap--pill" data-action="send-flow-edit-recipient" role="button" tabindex="0">
        <span class="send-input-label">To</span>
        <span class="send-recipient-pill">${escapeHtml(shortAddress(recipient))}</span>
      </div>
      <div class="send-amount-wrap">
        <input
          class="send-amount-input"
          id="send-flow-amount"
          data-draft="sendDraft"
          name="amount"
          type="text"
          inputmode="decimal"
          placeholder="0"
          value="${escapeHtml(state.sendDraft.amount)}"
          autocomplete="off"
          autofocus
        />
      </div>
      <div class="send-selected-asset" data-action="send-flow-change-asset" role="button" tabindex="0">
        <span class="send-token-icon">${escapeHtml(selectedAsset?.symbol?.slice(0, 2).toUpperCase() ?? "A")}</span>
        <span class="send-token-meta">
          <span class="send-token-symbol">${escapeHtml(selectedAsset?.name ?? "No asset selected")}</span>
          <span class="send-token-balance">${escapeHtml(selectedAsset?.displayBalance ?? "0")} ${escapeHtml(selectedAsset?.symbol ?? "")}</span>
        </span>
        <button class="send-inline-pill" type="button" data-action="send-flow-use-max" ${selectedAsset ? "" : "disabled"}>
          Use Max
        </button>
      </div>
      <div class="send-footer">
        <button class="primary-button send-flow-continue" type="button" data-action="send-flow-review" ${hasValidAmount ? "" : "disabled"}>
          Continue
        </button>
      </div>
    </section>
  `;
}

function renderSendFlowConfirmStep() {
  const selectedAsset = getSelectedAsset();
  const recipient = state.sendDraft.recipient.trim();
  const amount = state.sendDraft.amount.trim();

  return `
    <section class="send-flow-stage send-screen send-screen--confirm send-flow-stage--confirm">
      <h3 class="send-confirm-title">Confirm send to ${escapeHtml(shortAddress(recipient))}</h3>
      <div class="send-confirm-grid">
        <div class="send-confirm-row send-confirm-row--headline"><span>Total Value</span><strong>$${escapeHtml(amount || "0")}</strong></div>
        <div class="send-confirm-row"><span>Send ${escapeHtml(selectedAsset?.symbol ?? "Asset")}</span><strong>${escapeHtml(amount)} ${escapeHtml(selectedAsset?.symbol ?? "")}</strong></div>
        <div class="send-confirm-row"><span>From</span><strong>${escapeHtml(shortAddress(state.session?.account?.address ?? ""))}</strong></div>
      </div>
      <div class="send-fee-box">
        <div>
          <strong>$0.05</strong>
          <span>Fee Estimate</span>
        </div>
        <div class="send-fee-box-meta">
          <strong>Normal</strong>
          <span>~ 45 Secs</span>
        </div>
      </div>
      <p class="send-confirm-note">Review the details before confirming. Transactions on-chain are irreversible.</p>
      <div class="send-footer">
        <button class="primary-button send-flow-continue" type="button" data-action="send-flow-confirm" ${state.sendFlow.status === "pending" ? "disabled" : ""}>
          ${state.sendFlow.status === "pending" ? "Starting..." : "Confirm"}
        </button>
      </div>
    </section>
  `;
}

function renderSendFlowProcessingStep() {
  if (state.sendFlow.status === "success") {
    return `
      <section class="send-flow-stage send-screen send-flow-stage--processing">
        <div class="send-processing-icon send-processing-icon--success">✓</div>
        <h3>Transaction Sent</h3>
        <p>${escapeHtml(state.sendFlow.detail || "Your transfer has been submitted and confirmed.")}</p>
        <div class="send-processing-actions">
          ${
            state.sendFlow.txLink
              ? `<a class="secondary-button send-link-button" href="${state.sendFlow.txLink}" target="_blank" rel="noreferrer">View transaction</a>`
              : ""
          }
          <button class="primary-button send-flow-continue" type="button" data-action="send-flow-done">Done</button>
        </div>
      </section>
    `;
  }

  if (state.sendFlow.status === "error") {
    return `
      <section class="send-flow-stage send-screen send-flow-stage--processing">
        <div class="send-processing-icon send-processing-icon--error">!</div>
        <h3>Transaction Failed</h3>
        <p>${escapeHtml(state.sendFlow.detail || "We could not submit this transfer. Please review details and try again.")}</p>
        <button class="primary-button send-flow-continue" type="button" data-action="send-flow-back">
          Back to review
        </button>
      </section>
    `;
  }

  return `
    <section class="send-flow-stage send-screen send-flow-stage--processing send-flow-stage--processing-pending">
      <div class="send-processing-icon">➤</div>
      <h3>Starting Your Transaction</h3>
      <p>Just a moment.</p>
      <div class="send-processing-spacer"></div>
      <div class="spinner send-flow-spinner" aria-hidden="true"></div>
    </section>
  `;
}

function renderSendFlow() {
  if (!state.sendFlow.isOpen) {
    return "";
  }

  const step = state.sendFlow.step;
  const showBack = step === "confirm";
  const showClose = step !== "processing" || state.sendFlow.status !== "pending";
  const showHelp = step === "confirm";
  const hideHeader = step === "processing" && state.sendFlow.status === "pending";

  const stageMarkup =
    step === "recipient"
      ? renderSendFlowRecipientStep()
      : step === "asset"
        ? renderSendFlowAssetStep()
        : step === "amount"
          ? renderSendFlowAmountStep()
          : step === "confirm"
            ? renderSendFlowConfirmStep()
            : renderSendFlowProcessingStep();

  return `
    <div class="send-flow-overlay">
      <div class="send-flow-panel">
        ${
          hideHeader
            ? ""
            : `<header class="send-flow-head">
              ${
                showBack
                  ? '<button class="icon-button" type="button" data-action="send-flow-back" aria-label="Back">‹</button>'
                  : '<span class="send-flow-spacer"></span>'
              }
              <h2>Send</h2>
              ${
                showHelp
                  ? '<button class="icon-button icon-button--ghost" type="button" data-action="send-flow-help" aria-label="Help">?</button>'
                  : showClose
                    ? '<button class="icon-button" type="button" data-action="close-send-flow" aria-label="Close">✕</button>'
                    : '<span class="send-flow-spacer"></span>'
              }
            </header>`
        }
        <div class="send-flow-body">
          ${stageMarkup}
        </div>
      </div>
    </div>
  `;
}

function renderSmartWalletCards() {
  if (!state.smartWallets.length) {
    return `
      <div class="empty-state">
        <div>
          <div>No smart wallets discovered yet.</div>
          <div class="asset-note">Create a Lit-backed wallet below or refresh after deploying one from the configured factory.</div>
        </div>
      </div>
    `;
  }

  return `
    <div class="smart-wallet-list">
      ${state.smartWallets
        .map((smartWallet) => {
          const isSelected = smartWallet.walletAddress === state.selectedSmartWalletAddress;
          const modeLabel = canExecuteSmartWallet(smartWallet)
            ? "Ready to send"
            : smartWallet.kind === "lit"
              ? "Needs local Lit config"
              : "Legacy";

          return `
            <article class="smart-wallet-card ${isSelected ? "is-selected" : ""}">
              <div class="smart-wallet-head">
                <div>
                  <div class="asset-symbol">2-of-2 Smart Wallet</div>
                  <a class="address-link" href="${EXPLORER_ADDRESS_BASE_URL}${smartWallet.walletAddress}" target="_blank" rel="noreferrer">
                    ${shortAddress(smartWallet.walletAddress)}
                  </a>
                </div>
                <div class="smart-wallet-meta">
                  <span class="status-badge ${smartWallet.deployed ? "status-badge--live" : "status-badge--pending"}">
                    ${smartWallet.deployed ? "Deployed" : "Pending"}
                  </span>
                  <span class="asset-note">${modeLabel}</span>
                </div>
              </div>
              <div class="owners-list">
                ${smartWallet.owners
                  .map(
                    (owner, index) => `
                      <div class="owner-chip">
                        <span class="owner-index">Signer ${index + 1}</span>
                        <a class="address-link" href="${EXPLORER_ADDRESS_BASE_URL}${owner}" target="_blank" rel="noreferrer">
                          ${shortAddress(owner)}
                        </a>
                      </div>
                    `,
                  )
                  .join("")}
              </div>
              ${
                smartWallet.litConfig
                  ? `<div class="asset-note">PKP ${shortAddress(smartWallet.litConfig.pkpEthAddress)} · Action ${smartWallet.litConfig.actionIpfsCid.slice(0, 10)}...</div>`
                  : `<div class="asset-note">Factory ${shortAddress(smartWallet.sourceFactory)} · Salt ${smartWallet.salt.slice(0, 10)}...</div>`
              }
              <div class="action-row">
                <button class="secondary-button" type="button" data-action="select-smart-wallet" data-wallet="${smartWallet.walletAddress}">
                  ${isSelected ? "Opened" : "Open"}
                </button>
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderSmartWalletDiscoverySection() {
  return `
    <section class="section">
      <div class="section-head">
        <h2>Discovered wallets</h2>
        <div class="hint">${state.smartWallets.length} found</div>
      </div>
      <div class="asset-note">Click Open to load that wallet, view assets, and send from that wallet.</div>
      <div class="wallet-picker-scroll">
        ${renderSmartWalletCards()}
      </div>
    </section>
  `;
}

function renderSkeletonRows(count = 3) {
  return Array.from({ length: count })
    .map(
      () => `
        <div class="dash-skeleton-row">
          <div class="dash-skeleton-avatar"></div>
          <div class="dash-skeleton-info">
            <div class="dash-skeleton-line" style="width:88px;height:14px"></div>
            <div class="dash-skeleton-line" style="width:52px;height:11px;margin-top:5px"></div>
          </div>
          <div class="dash-skeleton-right">
            <div class="dash-skeleton-line" style="width:64px;height:14px"></div>
            <div class="dash-skeleton-line" style="width:36px;height:11px;margin-top:5px"></div>
          </div>
        </div>
      `,
    )
    .join("");
}

function renderDashTokenRows(assets) {
  if (state.isRefreshing && !assets.length) {
    return renderSkeletonRows(3);
  }

  if (!assets.length) {
    return `<div class="dash-empty">${state.isDiscoveringTokens ? 'Syncing\u2026' : 'No tokens yet. Tap + to add one.'}</div>`;
  }

  return assets
    .map(
      (asset) => `
        <div class="dash-token-row">
          <div class="dash-token-avatar">${escapeHtml(asset.symbol.slice(0, 1))}</div>
          <div class="dash-token-info">
            <div class="dash-token-name">${escapeHtml(asset.name)}</div>
            <div class="dash-token-sub">${escapeHtml(asset.symbol)}${asset.type === "token" ? ` · ${shortAddress(asset.address)}` : " · Sepolia"}</div>
          </div>
          <div class="dash-token-right">
            <div class="dash-token-bal">${escapeHtml(asset.displayBalance)}</div>
            <div class="dash-token-bal-note">${asset.error ? escapeHtml(asset.error) : escapeHtml(asset.symbol)}</div>
          </div>
          <button class="token-send-btn" type="button" data-action="open-send-flow" data-asset-id="${asset.id}" title="Send ${escapeHtml(asset.symbol)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
      `,
    )
    .join("");
}

function renderAddTokenSheet() {
  if (!state.addTokenOpen) return "";
  return `
    <div class="add-token-sheet">
      <div class="add-token-sheet-head">
        <span class="label">Add ERC-20 token</span>
        <button class="icon-button icon-button--ghost" type="button" data-action="toggle-add-token">✕</button>
      </div>
      <form data-form="add-token" class="form-grid">
        <div class="field">
          <input
            id="token-address"
            data-draft="addTokenDraft"
            name="address"
            type="text"
            placeholder="Token contract address (0x...)"
            value="${state.addTokenDraft.address}"
            required
          />
        </div>
        <button class="primary-button" type="submit" ${state.isWorking ? "disabled" : ""}>
          ${state.isWorking ? "Loading..." : "Add token"}
        </button>
      </form>
    </div>
  `;
}

function renderSmartWalletSendProgress() {
  const progress = state.smartWalletSendProgress;
  if (!progress.visible) {
    return "";
  }

  const summary = progress.summary ? `<div class="asset-note">${escapeHtml(progress.summary)}</div>` : "";
  return `
    <div class="progress-timeline-wrap">
      <div class="section-head">
        <h2>Transfer progress</h2>
        <div class="hint progress-hint progress-hint--${progress.status}">${escapeHtml(progress.status)}</div>
      </div>
      ${summary}
      <div class="progress-timeline">
        ${progress.steps
          .map(
            (step) => `
              <div class="progress-step progress-step--${step.status}">
                <div class="progress-step-label">${escapeHtml(step.label)}</div>
                <div class="progress-step-status">${escapeHtml(step.status)}${step.detail ? ` · ${escapeHtml(step.detail)}` : ""}</div>
              </div>
            `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderSelectedSmartWalletSection() {
  const smartWallet = getSelectedSmartWallet();
  if (!smartWallet) {
    return "";
  }
  const selectedAsset = getSelectedSmartWalletAsset();
  const csvPreview = getTopCsvPreview(state.smartWalletSendDraft.csvText);

  const canSend = canExecuteSmartWallet(smartWallet);

  return `
    <section class="section">
      <div class="section-head">
        <h2>Wallet</h2>
        <div class="hint">
          ${
            state.isSmartWalletAssetsLoading
              ? "Loading assets..."
              : canSend
                ? "Opened for sends"
                : "View only"
          }
        </div>
      </div>
      <article class="smart-wallet-card is-selected">
        <div class="smart-wallet-head">
          <div>
            <div class="asset-symbol">2-of-2 Smart Wallet</div>
            <a class="address-link" href="${EXPLORER_ADDRESS_BASE_URL}${smartWallet.walletAddress}" target="_blank" rel="noreferrer">
              ${shortAddress(smartWallet.walletAddress)}
            </a>
          </div>
          <div class="smart-wallet-meta">
            <span class="status-badge ${smartWallet.deployed ? "status-badge--live" : "status-badge--pending"}">
              ${smartWallet.deployed ? "Deployed" : "Pending"}
            </span>
            <span class="asset-note">${canSend ? "Ready to send" : "View only"}</span>
          </div>
        </div>
      </article>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>Assets</h2>
        <div class="hint">${state.smartWalletAssets.length} tracked</div>
      </div>
      <div class="asset-list">
        ${renderAssetRows(state.smartWalletAssets)}
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>Send</h2>
        <div class="hint">Send from selected smart-wallet asset</div>
      </div>
      ${
        canSend
          ? `
            <form data-form="smart-wallet-send" class="form-grid">
              <div class="field">
                <label class="label">Selected asset</label>
                <div class="asset-send-target">
                  ${
                    selectedAsset
                      ? `${escapeHtml(selectedAsset.symbol)} · ${escapeHtml(selectedAsset.displayBalance)}`
                      : state.isSmartWalletAssetsLoading || state.isDiscoveringTokens
                        ? "Loading wallet assets..."
                        : "Select an asset from the list above."
                  }
                </div>
                <div class="asset-note">Click Send next to any asset above to choose what to transfer.</div>
              </div>
              <div class="field">
                <label class="label" for="smart-send-recipient">Recipient</label>
                <input id="smart-send-recipient" data-draft="smartWalletSendDraft" name="recipient" type="text" placeholder="0x..." value="${state.smartWalletSendDraft.recipient}" required />
              </div>
              <div class="field">
                <label class="label" for="smart-send-amount">Amount</label>
                <input id="smart-send-amount" data-draft="smartWalletSendDraft" name="amount" type="text" inputmode="decimal" placeholder="0.0" value="${state.smartWalletSendDraft.amount}" required />
              </div>
              <div class="field">
                <label class="label" for="smart-csv-upload">CSV features</label>
                <input id="smart-csv-upload" name="csvUpload" type="file" accept=".csv,text/csv" data-file-kind="smart-wallet-csv" />
                <div class="asset-note">${state.smartWalletSendDraft.csvFileName || "Upload any CSV with feature headers. The top data row is used automatically."}</div>
                <label class="label" for="smart-eeg-simulated">Simulated EEG Aid</label>
                <select
                  id="smart-eeg-simulated"
                  data-draft="smartWalletSendDraft"
                  name="simulatedEmotion"
                >
                  ${renderSimulatedEegOptions()}
                </select>
                <div class="asset-note">Choose an emotion profile to auto-generate a test CSV for this transaction attempt.</div>
                ${
                  csvPreview?.ok
                    ? `<div class="asset-note">Using top row from ${csvPreview.dataRowCount} data row(s): ${escapeHtml(csvPreview.summary)}</div>`
                    : csvPreview?.error
                      ? `<div class="asset-note">CSV issue: ${escapeHtml(csvPreview.error)}</div>`
                      : ""
                }
              </div>
              <div class="action-row">
                <button class="primary-button" type="submit" ${state.isWorking || state.isSmartWalletAssetsLoading || !selectedAsset ? "disabled" : ""}>
                  ${
                    state.isWorking
                      ? "Processing transfer..."
                      : selectedAsset
                        ? `Send ${escapeHtml(selectedAsset.symbol)}`
                        : "Choose asset to send"
                  }
                </button>
              </div>
            </form>
            ${renderSmartWalletSendProgress()}
          `
          : `
            <div class="empty-state">
              <div>
                <div>This wallet is view-only in the current build.</div>
                <div class="asset-note">Legacy wallets stay discoverable, but only Chipotle-backed wallets with encrypted Lit metadata can submit transactions.</div>
              </div>
            </div>
            ${renderSmartWalletSendProgress()}
          `
      }
    </section>
  `;
}

function renderWalletCreatedOverlay() {
  if (!state.walletCreatedOverlay.visible) return "";
  return `
    <div class="wallet-success-overlay">
      <div class="wallet-success-card">
        <div class="wallet-success-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <div class="wallet-success-title">Wallet Created</div>
        <div class="wallet-success-addr">${shortAddress(state.walletCreatedOverlay.address)}</div>
      </div>
    </div>
  `;
}

function renderSwSendFlowRecipientStep() {
  const canContinue = Boolean(state.smartWalletSendDraft.recipient.trim());
  return `
    <section class="send-flow-stage send-screen send-screen--recipient">
      <div class="send-input-wrap">
        <label class="send-input-label" for="sw-send-recipient">To</label>
        <input
          id="sw-send-recipient"
          data-draft="smartWalletSendDraft"
          name="recipient"
          type="text"
          placeholder="0x..."
          value="${escapeHtml(state.smartWalletSendDraft.recipient)}"
          autocomplete="off"
          spellcheck="false"
        />
        <button class="send-inline-pill" type="button" data-action="sw-send-flow-paste">Paste</button>
      </div>
      <div class="send-footer">
        <button class="primary-button send-flow-continue" type="button" data-action="sw-send-flow-next-recipient" ${canContinue ? "" : "disabled"}>
          Continue
        </button>
      </div>
    </section>
  `;
}

function renderSwSendFlowAssetStep() {
  const recipient = state.smartWalletSendDraft.recipient.trim();
  const tokensMarkup = state.smartWalletAssets.length > 0
    ? state.smartWalletAssets.map((asset) => {
        const isSelected = asset.id === state.smartWalletSendDraft.assetId;
        return `
          <button class="send-token-row ${isSelected ? "is-selected" : ""}" type="button"
            data-action="sw-send-flow-select-asset" data-asset-id="${asset.id}">
            <span class="send-token-icon">${escapeHtml(asset.symbol.slice(0, 2).toUpperCase())}</span>
            <span class="send-token-meta">
              <span class="send-token-symbol">${escapeHtml(asset.name)}</span>
              <span class="send-token-balance">${escapeHtml(asset.displayBalance)} ${escapeHtml(asset.symbol)}</span>
            </span>
            <span class="send-token-value">${isSelected ? "Selected" : escapeHtml(asset.displayBalance)}</span>
          </button>
        `;
      }).join("")
    : '<div class="send-section-empty">No assets loaded yet. Refresh balances first.</div>';
  return `
    <section class="send-flow-stage send-screen send-screen--assets">
      <div class="send-input-wrap send-input-wrap--pill">
        <span class="send-input-label">To</span>
        <span class="send-recipient-pill">${escapeHtml(shortAddress(recipient))}</span>
      </div>
      <div class="send-token-list">${tokensMarkup}</div>
    </section>
  `;
}

function renderSwSendFlowAmountStep() {
  const selectedAsset = getSelectedSmartWalletAsset();
  const hasValidAmount = isValidAmount(state.smartWalletSendDraft.amount);
  const recipient = state.smartWalletSendDraft.recipient.trim();
  return `
    <section class="send-flow-stage send-screen send-screen--amount send-flow-stage--amount">
      <div class="send-input-wrap send-input-wrap--pill">
        <span class="send-input-label">To</span>
        <span class="send-recipient-pill">${escapeHtml(shortAddress(recipient))}</span>
      </div>
      <div class="send-amount-wrap">
        <input
          class="send-amount-input"
          id="sw-send-amount"
          data-draft="smartWalletSendDraft"
          name="amount"
          type="text"
          inputmode="decimal"
          placeholder="0"
          value="${escapeHtml(state.smartWalletSendDraft.amount)}"
          autocomplete="off"
          autofocus
        />
      </div>
      <div class="send-selected-asset">
        <span class="send-token-icon">${escapeHtml(selectedAsset?.symbol?.slice(0, 2).toUpperCase() ?? "A")}</span>
        <span class="send-token-meta">
          <span class="send-token-symbol">${escapeHtml(selectedAsset?.name ?? "No asset selected")}</span>
          <span class="send-token-balance">${escapeHtml(selectedAsset?.displayBalance ?? "0")} ${escapeHtml(selectedAsset?.symbol ?? "")}</span>
        </span>
        <button class="send-inline-pill" type="button" data-action="sw-send-flow-use-max" ${selectedAsset ? "" : "disabled"}>Use Max</button>
      </div>
      <div class="send-footer">
        <button class="primary-button send-flow-continue" type="button" data-action="sw-send-flow-next-amount" ${hasValidAmount ? "" : "disabled"}>
          Continue
        </button>
      </div>
    </section>
  `;
}

function renderSwSendFlowCsvStep() {
  const selectedAsset = getSelectedSmartWalletAsset();
  const recipient = state.smartWalletSendDraft.recipient.trim();
  const amount = state.smartWalletSendDraft.amount.trim();
  const simulatedEmotion = state.smartWalletSendDraft.simulatedEmotion;
  const hasSimulatedProfile = Boolean(simulatedEmotion && simulatedEmotion !== "manual");
  const fallbackSimulated = hasSimulatedProfile ? simulatedCsvForEmotion(simulatedEmotion) : null;
  const effectiveCsvText = state.smartWalletSendDraft.csvText || fallbackSimulated?.csvText || "";
  const csvPreview = getTopCsvPreview(effectiveCsvText);
  const hasCsvInput = !!csvPreview?.ok || hasSimulatedProfile;
  const canSend = !state.isWorking && !state.isSmartWalletAssetsLoading && !!selectedAsset && hasCsvInput;
  return `
    <section class="send-flow-stage send-screen">
      <div class="send-confirm-grid">
        <div class="send-confirm-row"><span>To</span><strong>${escapeHtml(shortAddress(recipient))}</strong></div>
        <div class="send-confirm-row"><span>Asset</span><strong>${escapeHtml(selectedAsset?.symbol ?? "")}</strong></div>
        <div class="send-confirm-row"><span>Amount</span><strong>${escapeHtml(amount)} ${escapeHtml(selectedAsset?.symbol ?? "")}</strong></div>
      </div>
      <div class="field" style="margin-top:16px">
        <label class="send-input-label" for="sw-csv-upload">CSV features</label>
        <input id="sw-csv-upload" name="csvUpload" type="file" accept=".csv,text/csv" data-file-kind="smart-wallet-csv" />
        <div class="asset-note">${escapeHtml(state.smartWalletSendDraft.csvFileName || "Upload any CSV with feature headers. The top data row is used automatically.")}</div>
        ${csvPreview?.ok ? `<div class="asset-note">Using top row from ${csvPreview.dataRowCount} data row(s): ${escapeHtml(csvPreview.summary)}</div>` : ""}
        ${csvPreview?.error ? `<div class="asset-note">CSV issue: ${escapeHtml(csvPreview.error)}</div>` : ""}
      </div>
      <div class="field">
        <label class="send-input-label" for="sw-eeg-simulated">Simulated EEG Aid</label>
        <select id="sw-eeg-simulated" data-draft="smartWalletSendDraft" name="simulatedEmotion">
          ${renderSimulatedEegOptions()}
        </select>
        <div class="asset-note">Choose an emotion profile to auto-generate a test CSV for this transaction attempt.</div>
      </div>
      <div class="send-footer">
        <button class="primary-button" type="button" data-action="sw-send-flow-confirm" ${canSend ? "" : "disabled"}>
          Send ${escapeHtml(selectedAsset?.symbol ?? "")}
        </button>
      </div>
    </section>
  `;
}

function renderSwSendFlowProcessingStep() {
  const flow = state.smartWalletSendFlow;
  if (flow.status === "success") {
    return `
      <section class="send-flow-stage send-screen send-flow-stage--processing">
        <div class="send-processing-icon send-processing-icon--success">✓</div>
        <h3>Transaction Successful</h3>
        <p>Your transfer has been confirmed on-chain.</p>
        <div class="send-processing-actions">
          ${flow.txLink ? `<a class="secondary-button send-link-button" href="${flow.txLink}" target="_blank" rel="noreferrer">View transaction</a>` : ""}
          <button class="primary-button send-flow-continue" type="button" data-action="sw-send-flow-done">Done</button>
        </div>
      </section>
    `;
  }
  if (flow.status === "error") {
    return `
      <section class="send-flow-stage send-screen send-flow-stage--processing">
        <div class="send-processing-icon send-processing-icon--error">!</div>
        <h3>Transaction Failed</h3>
        <p>${escapeHtml(flow.detail || "The transfer could not be completed. Please review and try again.")}</p>
        <button class="primary-button send-flow-continue" type="button" data-action="sw-send-flow-back">
          Back to review
        </button>
      </section>
    `;
  }
  const progress = state.smartWalletSendProgress;
  if (!progress.visible) {
    return `
      <section class="send-flow-stage send-screen send-flow-stage--processing send-flow-stage--processing-pending">
        <div class="send-processing-icon">➤</div>
        <h3>Starting Your Transaction</h3>
        <p>Just a moment.</p>
        <div class="send-processing-spacer"></div>
        <div class="spinner send-flow-spinner" aria-hidden="true"></div>
      </section>
    `;
  }
  return `
    <div class="sw-progress-fullscreen">
      ${renderSmartWalletSendProgress()}
    </div>
  `;
}

function renderSmartWalletSendSheet() {
  if (!state.smartWalletSendOpen) return "";

  const flow = state.smartWalletSendFlow;
  const step = flow.step;
  const isPendingProcessing = step === "processing" && flow.status === "pending";
  const showBack = step === "asset" || step === "amount" || step === "csv" ||
    (step === "processing" && flow.status === "error");
  const showClose = !isPendingProcessing;

  const stageMarkup = step === "recipient"
    ? renderSwSendFlowRecipientStep()
    : step === "asset"
      ? renderSwSendFlowAssetStep()
      : step === "amount"
        ? renderSwSendFlowAmountStep()
        : step === "csv"
          ? renderSwSendFlowCsvStep()
          : renderSwSendFlowProcessingStep();

  return `
    <div class="send-flow-overlay">
      <div class="send-flow-panel">
        <header class="send-flow-head">
          ${showBack
            ? '<button class="icon-button" type="button" data-action="sw-send-flow-back" aria-label="Back">‹</button>'
            : '<span class="send-flow-spacer"></span>'
          }
          <h2>Send</h2>
          ${showClose
            ? '<button class="icon-button" type="button" data-action="close-smart-wallet-send" aria-label="Close">✕</button>'
            : '<span class="send-flow-spacer"></span>'
          }
        </header>
        <div class="send-flow-body">
          ${stageMarkup}
        </div>
      </div>
    </div>
  `;
}

function renderSmartWalletWalletView() {
  const smartWallet = getSelectedSmartWallet();
  if (!smartWallet) return "";

  const canSend = canExecuteSmartWallet(smartWallet);

  const copyIcon = state.smartWalletAddressCopied
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

  const litConfig = smartWallet.litConfig;
  const expanded = state.smartWalletHeaderExpanded;
  const pkpAddress = litConfig?.pkpEthAddress;
  const ipfsCid = litConfig?.actionIpfsCid;

  const headerLeft = expanded
    ? `<div class="sw-wallet-header-left">
        <button class="sw-wallet-addr sw-wallet-addr--clickable" type="button" data-action="toggle-smart-wallet-header" title="Show wallet address">${shortAddress(smartWallet.walletAddress)}</button>
        <div class="sw-wallet-meta-rows">
          ${pkpAddress
            ? `<div class="sw-wallet-meta-row">
                <span class="sw-wallet-meta-label">PKP</span>
                <a class="sw-wallet-meta-value address-link" href="${EXPLORER_ADDRESS_BASE_URL}${pkpAddress}" target="_blank" rel="noreferrer">${shortAddress(pkpAddress)}</a>
              </div>`
            : ""}
          ${ipfsCid
            ? `<div class="sw-wallet-meta-row">
                <span class="sw-wallet-meta-label">Action</span>
                <a class="sw-wallet-meta-value address-link" href="https://ipfs.io/ipfs/${escapeHtml(ipfsCid)}" target="_blank" rel="noreferrer">${escapeHtml(ipfsCid.slice(0, 12))}…</a>
              </div>`
            : ""}
        </div>
      </div>`
    : `<div class="sw-wallet-header-left">
        <div class="sw-wallet-address-row">
          <button class="sw-wallet-addr sw-wallet-addr--clickable" type="button" data-action="toggle-smart-wallet-header" title="Show Lit details">${shortAddress(smartWallet.walletAddress)}</button>
          <button class="dash-copy-btn" type="button" data-action="copy-smart-wallet-address" title="Copy address">${copyIcon}</button>
        </div>
      </div>`;

  return `
    <div class="sw-wallet-view">
      <section class="section">
        <div class="sw-wallet-header-card">
          ${headerLeft}
          <span class="status-badge ${smartWallet.deployed ? "status-badge--live" : "status-badge--pending"}">
            Smart Wallet
          </span>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <h2>Assets</h2>
          <div class="hint">${state.isSmartWalletAssetsLoading ? "Loading…" : `${state.smartWalletAssets.length} tracked`}</div>
        </div>
        <div class="asset-list">
          ${renderAssetRows(state.smartWalletAssets)}
        </div>
      </section>

    </div>
  `;
}

function renderSmartWalletPanel(address) {
  if (state.smartWalletView === "wallet" && state.selectedSmartWalletAddress) {
    return renderSmartWalletWalletView();
  }

  const featureEnabled = smartWalletFeatureReady();

  return `
    <section class="section">
      <div class="section-head">
        <h2>Create with Lit</h2>
        <div class="hint">PKP as signer two</div>
      </div>
      <form data-form="smart-wallet" class="form-grid">
        <div class="field">
          <label class="label" for="smart-owner1">Signer one</label>
          <input id="smart-owner1" type="text" value="${address}" disabled />
        </div>
        <div class="asset-note">This creates a 2-of-2 multi-sig smart wallet with equal authority: your current EOA signer and one Lit PKP signer (50/50).</div>
        <div class="asset-note">Inside a Lit Action, Impulse AI runs the inference policy check, and Lit PKP only signs when that policy passes.</div>
        <div class="asset-note">Keep some Sepolia ETH in your main EOA wallet because it pays gas to create and execute smart-wallet transactions.</div>
        <div class="field">
          <label class="label" for="smart-litAccountApiKey">Lit master account API key</label>
          <input
            id="smart-litAccountApiKey"
            data-draft="smartWalletDraft"
            name="litAccountApiKey"
            type="password"
            placeholder="Paste the Chipotle master key or Bearer token"
            value="${state.smartWalletDraft.litAccountApiKey}"
            required
          />
          <div class="asset-note">This setup flow needs the dashboard account key with management permissions.</div>
          <div class="asset-note">Get your Lit account key from <a class="address-link" href="https://dashboard.dev.litprotocol.com/" target="_blank" rel="noreferrer">dashboard.dev.litprotocol.com</a>.</div>
          
        </div>
        <div class="field">
          <label class="label" for="smart-deploymentId">Impulse deployment ID</label>
          <input
            id="smart-deploymentId"
            data-draft="smartWalletDraft"
            name="deploymentId"
            type="text"
            placeholder="sync-bd6cb3046188"
            value="${state.smartWalletDraft.deploymentId}"
            required
          />
          <div class="asset-note">Get deployment IDs from <a class="address-link" href="https://app.impulselabs.ai/" target="_blank" rel="noreferrer">app.impulselabs.ai</a>.</div>
        </div>
        <div class="field">
          <label class="label" for="smart-apiKey">Impulse API key</label>
          <input
            id="smart-apiKey"
            data-draft="smartWalletDraft"
            name="apiKey"
            type="password"
            placeholder="Enter the inference API key"
            value="${state.smartWalletDraft.apiKey}"
            required
          />
          <div class="asset-note">Create your Impulse API key in <a class="address-link" href="https://app.impulselabs.ai/" target="_blank" rel="noreferrer">app.impulselabs.ai</a>.</div>
          
        </div>
        <div class="action-row">
          <button class="primary-button" type="submit" ${state.isWorking || !featureEnabled ? "disabled" : ""}>
            ${featureEnabled ? (state.isWorking ? "Creating..." : "Create smart wallet") : "Factory not configured"}
          </button>
        </div>
        ${
          featureEnabled
            ? ""
            : '<div class="asset-note">Deploy the upgraded factory on Sepolia, then update src/smart-wallet-deployment.js with the new factory address and deployment block before creating Lit-backed wallets.</div>'
        }
      </form>
    </section>
  `;
}

function renderDashboardView() {
  const address = state.session?.account.address ?? state.walletMeta?.address ?? "";
  const isSmartWalletMode = state.homeTab === "smart-wallets" && !!state.selectedSmartWalletAddress;
  const nativeAsset = isSmartWalletMode
    ? (state.smartWalletAssets.find((a) => a.type === "native") ?? state.smartWalletAssets[0])
    : state.assets[0];
  const balance = nativeAsset?.displayBalance ?? "0";

  const assetsContent = `
    ${renderAddTokenSheet()}
    <div class="dash-tab-pane">
      ${state.isDiscoveringTokens && !state.assets.length && !state.isRefreshing ? '<div class="dash-syncing">Syncing tokens…</div>' : ""}
      <div class="dash-token-list">${renderDashTokenRows(state.assets)}</div>
    </div>
  `;

  const sendAction = isSmartWalletMode ? "open-smart-wallet-send-from-top" : "open-send-flow";
  const sendDisabled = isSmartWalletMode
    ? !state.smartWalletAssets.length || !canExecuteSmartWallet(getSelectedSmartWallet())
    : !state.assets.length;
  const networkTag = isSmartWalletMode
    ? `Smart Wallet${state.isSmartWalletAssetsLoading ? " · Loading…" : ""}`
    : `Sepolia${state.isRefreshing ? " · Refreshing…" : ""}`;

  return `
    <div class="dash-view">
      <div class="dash-balance-wrap">
        <div class="dash-balance-amount">${escapeHtml(balance)} <span class="dash-balance-sym">ETH</span></div>
        <div class="dash-network-tag">${networkTag}</div>
      </div>

      <div class="dash-quick-actions">
        <button class="dash-action-btn" type="button" data-action="${sendAction}" ${sendDisabled ? "disabled" : ""}>
          <span class="dash-action-icon-wrap">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </span>
          <span>Send</span>
        </button>
      </div>

      <div class="dash-tabs-bar">
        <div class="dash-tabs-left">
          <button class="dash-tab-btn ${state.homeTab === "assets" ? "is-active" : ""}" data-action="switch-home-tab" data-tab="assets">EOA</button>
          <button class="dash-tab-btn ${state.homeTab === "smart-wallets" ? "is-active" : ""}" data-action="switch-home-tab" data-tab="smart-wallets">Smart Wallets</button>
        </div>
        ${state.homeTab === "assets" ? `
          <button class="dash-add-btn" type="button" data-action="toggle-add-token" title="Add token">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        ` : ""}
      </div>

      <div class="dash-tab-content">
        ${state.homeTab === "assets" ? assetsContent : renderSmartWalletPanel(address)}
      </div>
    </div>
  `;
}

function renderMenuOverlay() {
  if (!state.menuOpen) return "";

  if (state.homeTab === "smart-wallets") {
    return `
      <div class="menu-overlay">
        <button class="menu-backdrop" type="button" data-action="close-menu" aria-label="Close menu"></button>
        <div class="menu-panel">
          <div class="menu-head">
            <span class="menu-title">Smart Wallets</span>
            <button class="icon-button" type="button" data-action="close-menu">✕</button>
          </div>
          <div class="menu-section">
            <div class="menu-section-label">Developer Mode</div>
            <label class="toggle-row menu-item">
              <div>
                <div class="label">Verbose step logging</div>
                <div class="asset-note">Log each Lit and smart-wallet step, plus the response payload that caused a failure.</div>
              </div>
              <input type="checkbox" data-setting="developerMode" ${state.developerMode ? "checked" : ""} />
            </label>
            ${renderDebugLog()}
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="menu-overlay">
      <button class="menu-backdrop" type="button" data-action="close-menu" aria-label="Close menu"></button>
      <div class="menu-panel">
        <div class="menu-head">
          <span class="menu-title">Settings</span>
          <button class="icon-button" type="button" data-action="close-menu">✕</button>
        </div>
        <div class="menu-section">
          <div class="menu-section-label">Backup</div>
          <button class="menu-item" type="button" data-action="export-backup" ${state.isWorking ? "disabled" : ""}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <span>Export encrypted backup</span>
          </button>
        </div>
        <div class="menu-section">
          <div class="menu-section-label">Restore</div>
          <form data-form="import-backup" class="menu-restore-form">
            <label class="menu-file-label" for="menu-backup-file">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              <span>${state.backupDraft.fileName || "Choose backup file"}</span>
              <input id="menu-backup-file" type="file" accept=".json,application/json,text/json" data-file-kind="wallet-backup" class="visually-hidden" />
            </label>
            <button class="menu-item menu-item--cta" type="submit" ${state.isWorking || !state.backupDraft.text ? "disabled" : ""}>
              ${state.isWorking ? "Restoring…" : "Restore from backup"}
            </button>
          </form>
        </div>
      </div>
    </div>
  `;
}

function render() {
  if (state.view === "unlock") {
    app.innerHTML = `
      <div class="shell">
        ${renderUnlockView()}
        ${renderMenuOverlay()}
      </div>
    `;
    return;
  }

  const viewMarkup = {
    loading: renderLoadingView(),
    onboarding: renderOnboardingView(),
    unlock: renderUnlockView(),
    recovery: renderRecoveryView(),
    dashboard: renderDashboardView(),
  }[state.view];

  app.innerHTML = `
    <div class="shell">
      <div class="frame">
        ${renderTopbar()}
        ${renderStatus()}
        ${viewMarkup}
      </div>
      ${renderSendFlow()}
      ${renderSmartWalletSendSheet()}
      ${renderMenuOverlay()}
      ${renderWalletCreatedOverlay()}
    </div>
  `;
}

function collectDiscoveryWalletAddresses() {
  const unique = new Map();

  if (state.session?.account?.address) {
    unique.set(state.session.account.address.toLowerCase(), state.session.account.address);
  }
