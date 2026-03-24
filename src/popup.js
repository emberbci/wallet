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
