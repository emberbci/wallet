import {
  english,
  generateMnemonic,
  mnemonicToAccount,
  privateKeyToAccount,
} from "viem/accounts";

export const DEFAULT_DERIVATION_PATH = "m/44'/60'/0'/0/0";

function isPrivateKeyCandidate(value) {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(value);
}

function normalizeMnemonic(value) {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

export function normalizeSecretInput(secret) {
  const normalized = secret.trim();

  if (!normalized) {
    throw new Error("Enter a recovery phrase or private key.");
  }

  if (isPrivateKeyCandidate(normalized)) {
    return {
      type: "privateKey",
      value: normalized.startsWith("0x") ? normalized.toLowerCase() : `0x${normalized.toLowerCase()}`,
    };
  }

  const mnemonic = normalizeMnemonic(normalized);
  if (mnemonic.split(" ").length >= 12) {
    return {
      type: "mnemonic",
      value: mnemonic,
    };
  }

  throw new Error("The import text is not a valid recovery phrase or private key.");
}

export function createMnemonicWallet() {
  const mnemonic = generateMnemonic(english);
  const account = mnemonicToAccount(mnemonic, { path: DEFAULT_DERIVATION_PATH });

  return {
    walletType: "mnemonic",
    address: account.address,
    mnemonic,
    derivationPath: DEFAULT_DERIVATION_PATH,
  };
}

export function importWallet(secret) {
  const normalized = normalizeSecretInput(secret);

  try {
    if (normalized.type === "privateKey") {
      const account = privateKeyToAccount(normalized.value);

      return {
        walletType: "privateKey",
        address: account.address,
        privateKey: normalized.value,
      };
    }

    const account = mnemonicToAccount(normalized.value, {
      path: DEFAULT_DERIVATION_PATH,
    });

    return {
      walletType: "mnemonic",
      address: account.address,
      mnemonic: normalized.value,
      derivationPath: DEFAULT_DERIVATION_PATH,
    };
  } catch (error) {
    throw new Error("Could not import that wallet. Check the recovery phrase or private key.");
  }
}

export function accountFromVault(payload) {
  if (payload.walletType === "privateKey") {
    return privateKeyToAccount(payload.privateKey);
  }

  return mnemonicToAccount(payload.mnemonic, {
    path: payload.derivationPath ?? DEFAULT_DERIVATION_PATH,
  });
}
