import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  fallback,
  formatEther,
  formatUnits,
  http,
  isAddress,
  parseEther,
  parseUnits,
} from "viem";

import { CHAIN, EXPLORER_TX_BASE_URL, NATIVE_ASSET, RPC_FALLBACKS } from "../config.js";
import { sanitizeTokenMetadata } from "./tokens.js";

const rpcTransport = fallback(RPC_FALLBACKS.map((url) => http(url)));

const publicClient = createPublicClient({
  chain: CHAIN,
  transport: rpcTransport,
});

function walletClientFor(account) {
  return createWalletClient({
    account,
    chain: CHAIN,
    transport: rpcTransport,
  });
}

export { publicClient, walletClientFor };

export function formatBalance(value, decimals) {
  const raw = decimals === 18 ? formatEther(value) : formatUnits(value, decimals);
  const [whole, fraction = ""] = raw.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "").slice(0, 6);

  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
}

export async function loadPortfolio(address, tokens = []) {
  const nativeBalance = await publicClient.getBalance({ address });
  const tokenBalances = await Promise.all(
    tokens.map(async (token) => {
      try {
        const balance = await publicClient.readContract({
          address: token.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        });

        return {
          ...token,
          id: `token:${token.address.toLowerCase()}`,
          balance,
          displayBalance: formatBalance(balance, token.decimals),
        };
      } catch (error) {
        return {
          ...token,
          id: `token:${token.address.toLowerCase()}`,
          balance: 0n,
          displayBalance: "Unavailable",
          error: "Could not load balance.",
        };
      }
    }),
  );

  return [
    {
      ...NATIVE_ASSET,
      balance: nativeBalance,
      displayBalance: formatBalance(nativeBalance, NATIVE_ASSET.decimals),
    },
    ...tokenBalances,
  ];
}

export async function lookupTokenMetadata(address) {
  try {
    const [name, symbol, decimals] = await Promise.all([
      publicClient.readContract({
        address,
        abi: erc20Abi,
        functionName: "name",
      }),
      publicClient.readContract({
        address,
        abi: erc20Abi,
        functionName: "symbol",
      }),
      publicClient.readContract({
        address,
        abi: erc20Abi,
        functionName: "decimals",
      }),
    ]);

    return sanitizeTokenMetadata({
      address,
      name,
      symbol,
      decimals,
    });
  } catch (error) {
    throw new Error("This contract could not be read as an ERC-20 token on Sepolia.");
  }
}

export async function sendAsset({ account, asset, recipient, amount }) {
  if (!isAddress(recipient)) {
    throw new Error("Enter a valid recipient address.");
  }

  if (!amount || Number(amount) <= 0) {
    throw new Error("Enter an amount greater than zero.");
  }

  try {
    const walletClient = walletClientFor(account);
    let hash;

    if (asset.type === "native") {
      hash = await walletClient.sendTransaction({
        to: recipient,
        value: parseEther(amount),
      });
    } else {
      const value = parseUnits(amount, asset.decimals);
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [recipient, value],
      });

      hash = await walletClient.sendTransaction({
        to: asset.address,
        data,
        value: 0n,
      });
    }

    await publicClient.waitForTransactionReceipt({ hash });

    return {
      hash,
      explorerUrl: `${EXPLORER_TX_BASE_URL}${hash}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transaction failed.";
    throw new Error(message);
  }
}
