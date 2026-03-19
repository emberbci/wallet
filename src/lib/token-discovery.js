import { erc20Abi, getAddress, isAddress, parseAbiItem } from "viem";

import { publicClient, lookupTokenMetadata } from "./chain.js";
import { mergeTokens } from "./tokens.js";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

function emitDiscoveryEvent(onProgressEvent, event) {
  if (typeof onProgressEvent !== "function") {
    return;
  }

  onProgressEvent({
    scope: "token-discovery",
    timestamp: new Date().toISOString(),
    ...event,
  });
}

function normalizeWalletAddresses(walletAddresses) {
  const unique = new Set();

  walletAddresses.forEach((address) => {
    if (!isAddress(address)) {
      return;
    }

    unique.add(getAddress(address));
  });

  return [...unique];
}

function parseCursor(value) {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(value);
  }

  if (typeof value === "string" && value.trim()) {
    try {
      return BigInt(value);
    } catch (error) {
      return null;
    }
  }

  return null;
}

async function getTransferLogsForWallet({
  walletAddress,
  fromBlock,
  toBlock,
  direction,
  onProgressEvent,
}) {
  const ranges = [{ fromBlock, toBlock }];
  const logs = [];
  const args = direction === "from" ? { from: walletAddress } : { to: walletAddress };

  while (ranges.length) {
    const range = ranges.shift();
    if (!range || range.fromBlock > range.toBlock) {
      continue;
    }

    try {
      const nextLogs = await publicClient.getLogs({
        event: transferEvent,
        args,
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
      });
      logs.push(...nextLogs);
    } catch (error) {
      if (range.fromBlock === range.toBlock) {
        throw error;
      }

      const midpoint = range.fromBlock + (range.toBlock - range.fromBlock) / 2n;
      ranges.unshift({ fromBlock: midpoint + 1n, toBlock: range.toBlock });
      ranges.unshift({ fromBlock: range.fromBlock, toBlock: midpoint });
      emitDiscoveryEvent(onProgressEvent, {
        step: "splitLogRange",
        status: "retry",
        detail: {
          direction,
          walletAddress,
          fromBlock: range.fromBlock.toString(),
          toBlock: range.toBlock.toString(),
        },
      });
    }
  }

  return logs;
}

async function hasBalanceForAnyWallet(tokenAddress, walletAddresses) {
  for (const walletAddress of walletAddresses) {
    try {
      const balance = await publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress],
      });

      if (balance > 0n) {
        return true;
      }
    } catch (error) {
      continue;
    }
  }

  return false;
}

export async function discoverTokensForWallets({
  walletAddresses,
  knownTokens = [],
  cursors = {},
  onProgressEvent,
}) {
  const addresses = normalizeWalletAddresses(walletAddresses);
  const nextCursors = { ...(cursors ?? {}) };

  if (!addresses.length) {
    return {
      tokens: knownTokens,
      cursors: nextCursors,
    };
  }

  const latestBlock = await publicClient.getBlockNumber();
  const discoveredTokenAddresses = new Set();

  emitDiscoveryEvent(onProgressEvent, {
    step: "discoverTokens",
    status: "start",
    detail: {
      walletCount: addresses.length,
      latestBlock: latestBlock.toString(),
    },
  });

  for (const walletAddress of addresses) {
    const cursorKey = walletAddress.toLowerCase();
    const previousCursor = parseCursor(nextCursors[cursorKey]);
    const fromBlock = previousCursor == null ? 0n : previousCursor + 1n;

    if (fromBlock > latestBlock) {
      nextCursors[cursorKey] = latestBlock.toString();
      continue;
    }

    const [sentLogs, receivedLogs] = await Promise.all([
      getTransferLogsForWallet({
        walletAddress,
        fromBlock,
        toBlock: latestBlock,
        direction: "from",
        onProgressEvent,
      }),
      getTransferLogsForWallet({
        walletAddress,
        fromBlock,
        toBlock: latestBlock,
        direction: "to",
        onProgressEvent,
      }),
    ]);

    sentLogs.forEach((log) => discoveredTokenAddresses.add(log.address.toLowerCase()));
    receivedLogs.forEach((log) => discoveredTokenAddresses.add(log.address.toLowerCase()));
    nextCursors[cursorKey] = latestBlock.toString();
  }

  const knownByAddress = new Map(
    knownTokens.map((token) => [token.address.toLowerCase(), token]),
  );
  const discoveredWithMetadata = [];

  for (const lowercaseAddress of discoveredTokenAddresses) {
    const existing = knownByAddress.get(lowercaseAddress);
    if (existing) {
      discoveredWithMetadata.push(existing);
      continue;
    }

    try {
      const metadata = await lookupTokenMetadata(getAddress(lowercaseAddress));
      discoveredWithMetadata.push(metadata);
    } catch (error) {
      continue;
    }
  }

  const discoveredWithBalance = [];
  for (const token of discoveredWithMetadata) {
    const keep = await hasBalanceForAnyWallet(token.address, addresses);
    if (keep) {
      discoveredWithBalance.push(token);
    }
  }

  const tokens = mergeTokens([...knownTokens, ...discoveredWithBalance]);
  emitDiscoveryEvent(onProgressEvent, {
    step: "discoverTokens",
    status: "success",
    detail: {
      walletCount: addresses.length,
      discoveredTokenCount: discoveredWithBalance.length,
      totalTrackedTokens: tokens.length,
    },
  });

  return {
    tokens,
    cursors: nextCursors,
  };
}
