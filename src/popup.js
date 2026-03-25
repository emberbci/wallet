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

