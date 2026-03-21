const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_ITERATIONS = 250000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

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

async function deriveKey(password, salt, iterations = DEFAULT_ITERATIONS) {
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

export async function encryptVault(payload, password) {
  if (!password || password.length < 8) {
    throw new Error("Use a password with at least 8 characters.");
  }

  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(payload)),
  );

  return {
    vault: bytesToBase64(new Uint8Array(ciphertext)),
    vaultMeta: {
      version: 1,
      address: payload.address,
      walletType: payload.walletType,
      derivationPath: payload.derivationPath ?? null,
      kdf: {
        name: "PBKDF2",
        iterations: DEFAULT_ITERATIONS,
        hash: "SHA-256",
      },
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
    },
  };
}

export async function decryptVault(vault, vaultMeta, password) {
  if (!vault || !vaultMeta) {
    throw new Error("No encrypted wallet was found.");
  }

  try {
    const salt = base64ToBytes(vaultMeta.salt);
    const iv = base64ToBytes(vaultMeta.iv);
    const iterations = vaultMeta.kdf?.iterations ?? DEFAULT_ITERATIONS;
    const key = await deriveKey(password, salt, iterations);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      base64ToBytes(vault),
    );

    return JSON.parse(decoder.decode(plaintext));
  } catch (error) {
    throw new Error("Could not unlock the wallet. Check the password and try again.");
  }
}
