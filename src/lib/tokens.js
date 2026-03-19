import { checksumAddress, isAddress } from "viem";

export function normalizeTokenAddress(value) {
  const trimmed = value.trim();

  if (!isAddress(trimmed)) {
    throw new Error("Enter a valid ERC-20 contract address.");
  }

  return checksumAddress(trimmed);
}

export function sanitizeTokenMetadata(token) {
  const address = normalizeTokenAddress(token.address);
  const name = `${token.name ?? ""}`.trim();
  const symbol = `${token.symbol ?? ""}`.trim().toUpperCase();
  const decimals = Number(token.decimals);

  if (!name) {
    throw new Error("The token contract did not return a usable name.");
  }

  if (!symbol) {
    throw new Error("The token contract did not return a usable symbol.");
  }

  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("The token contract returned unsupported decimals.");
  }

  return {
    address,
    name,
    symbol,
    decimals,
    type: "token",
  };
}

export function mergeTokens(tokens) {
  const byAddress = new Map();

  tokens.forEach((token) => {
    byAddress.set(token.address.toLowerCase(), token);
  });

  return [...byAddress.values()];
}
