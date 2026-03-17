const encoder = new TextEncoder();
const decoder = new TextDecoder();

const LOCAL_CONFIG_KDF_ITERATIONS = 180000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }

  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function normalizeSecretConfig(secretConfig) {
  if (
    !secretConfig ||
    typeof secretConfig !== "object" ||
    !secretConfig.endpoint ||
    !secretConfig.apiKey ||
    !secretConfig.deploymentId
  ) {
    throw new Error("Missing inference configuration for Lit-backed signing.");
  }

  return {
    endpoint: String(secretConfig.endpoint),
    apiKey: String(secretConfig.apiKey),
    deploymentId: String(secretConfig.deploymentId),
  };
}

async function deriveKey(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

function localConfigAad(pkpId) {
  return encoder.encode(`ember:lit-local-config:${String(pkpId ?? "").toLowerCase()}`);
}

export async function sealInferenceConfig(secretConfig, { password, pkpId }) {
  if (!password || password.length < 8) {
    throw new Error(
      "A local vault password is required to protect Lit config on this device. Lock and unlock the wallet, then retry.",
    );
  }

  const normalized = normalizeSecretConfig(secretConfig);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(password, salt, LOCAL_CONFIG_KDF_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: localConfigAad(pkpId),
    },
    key,
    encoder.encode(JSON.stringify(normalized)),
  );

  return {
    storageMode: "local_aes_gcm_v1",
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    kdf: "PBKDF2-SHA256",
    iterations: LOCAL_CONFIG_KDF_ITERATIONS,
  };
}

export async function openInferenceConfig(encryptedConfig, { password, pkpId }) {
  if (!password || password.length < 8) {
    throw new Error(
      "The local vault password is required to unlock Lit config for this wallet. Lock and unlock, then try again.",
    );
  }

  if (
    !encryptedConfig ||
    typeof encryptedConfig !== "object" ||
    !encryptedConfig.ciphertext ||
    !encryptedConfig.salt ||
    !encryptedConfig.iv
  ) {
    throw new Error("This wallet is missing local encrypted Lit config and cannot sign yet.");
  }

  const iterations =
    Number.isInteger(encryptedConfig.iterations) && encryptedConfig.iterations > 0
      ? encryptedConfig.iterations
      : LOCAL_CONFIG_KDF_ITERATIONS;
  const key = await deriveKey(password, base64ToBytes(encryptedConfig.salt), iterations);

  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(encryptedConfig.iv),
        additionalData: localConfigAad(pkpId),
      },
      key,
      base64ToBytes(encryptedConfig.ciphertext),
    );
  } catch (error) {
    throw new Error(
      "Could not unlock this wallet's local Lit config. Recreate the wallet or restore from a valid backup.",
    );
  }

  let parsed = null;
  try {
    parsed = JSON.parse(decoder.decode(plaintext));
  } catch (error) {
    parsed = null;
  }

  return normalizeSecretConfig(parsed);
}
