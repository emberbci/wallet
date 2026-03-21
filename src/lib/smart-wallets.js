import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  fallback,
  getAddress,
  http,
  isAddress,
  parseAbiItem,
  parseEther,
  parseUnits,
  toHex,
} from "viem";

import {
  CHAIN,
  ENTRY_POINT_ADDRESS,
  EXPLORER_TX_BASE_URL,
  LEGACY_SMART_WALLET_FACTORY_ADDRESS,
  LEGACY_SMART_WALLET_FACTORY_DEPLOYMENT_BLOCK,
  RPC_FALLBACKS,
  SMART_WALLET_ABI,
  SMART_WALLET_FACTORY_ABI,
  SMART_WALLET_FACTORY_ADDRESS,
  SMART_WALLET_FACTORY_DEPLOYMENT_BLOCK,
} from "../config.js";
import { requestLitSignature } from "./lit.js";
import { walletClientFor } from "./chain.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const publicClient = createPublicClient({
  chain: CHAIN,
  transport: fallback(RPC_FALLBACKS.map((url) => http(url))),
});
const walletCreatedEvent = parseAbiItem(
  "event WalletCreated(address indexed wallet, address indexed owner1, address indexed owner2, uint256 salt)",
);

function emitDebugEvent(onDebugEvent, event) {
  if (typeof onDebugEvent !== "function") {
    return;
  }

  onDebugEvent({
    scope: "smart-wallet",
    timestamp: new Date().toISOString(),
    ...event,
  });
}

function emitProgressEvent(onProgressEvent, event) {
  if (typeof onProgressEvent !== "function") {
    return;
  }

  onProgressEvent({
    scope: "smart-wallet",
    timestamp: new Date().toISOString(),
    ...event,
  });
}

function createSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return BigInt(`0x${hex}`);
}

function normalizeSalt(salt) {
  const value = typeof salt === "bigint" ? salt : BigInt(salt);
  return toHex(value, { size: 32 });
}

async function hasDeployedCode(address) {
  const code = await publicClient.getCode({ address });
  return Boolean(code && code !== "0x");
}

async function supportsExecution(walletAddress) {
  try {
    await publicClient.readContract({
      address: walletAddress,
      abi: SMART_WALLET_ABI,
      functionName: "nonce",
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function readWalletOwners(walletAddress) {
  try {
    const owners = await publicClient.readContract({
      address: walletAddress,
      abi: SMART_WALLET_ABI,
      functionName: "owners",
    });

    return owners.map((owner) => getAddress(owner));
  } catch (error) {
    return null;
  }
}

function activeFactories() {
  const factories = [];

  if (isAddress(LEGACY_SMART_WALLET_FACTORY_ADDRESS) && LEGACY_SMART_WALLET_FACTORY_ADDRESS !== ZERO_ADDRESS) {
    factories.push({
      address: getAddress(LEGACY_SMART_WALLET_FACTORY_ADDRESS),
      fromBlock: LEGACY_SMART_WALLET_FACTORY_DEPLOYMENT_BLOCK,
      mode: "legacy",
    });
  }

  if (isAddress(SMART_WALLET_FACTORY_ADDRESS) && SMART_WALLET_FACTORY_ADDRESS !== ZERO_ADDRESS) {
    factories.push({
      address: getAddress(SMART_WALLET_FACTORY_ADDRESS),
      fromBlock: SMART_WALLET_FACTORY_DEPLOYMENT_BLOCK,
      mode: "lit",
    });
  }

  return factories;
}

function ensureFactoryReady() {
  if (!smartWalletFeatureReady()) {
    throw new Error("The Lit smart wallet factory is not configured yet. Deploy the upgraded Sepolia factory first.");
  }
}

function buildSmartWalletCall(asset, recipient, amount) {
  if (!isAddress(recipient)) {
    throw new Error("Enter a valid recipient address.");
  }

  if (!amount || Number(amount) <= 0) {
    throw new Error("Enter an amount greater than zero.");
  }

  if (asset.type === "native") {
    return {
      target: getAddress(recipient),
      value: parseEther(amount),
      data: "0x",
    };
  }

  const value = parseUnits(amount, asset.decimals);
  return {
    target: asset.address,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [getAddress(recipient), value],
    }),
  };
}

function normalizeLitConfig(litConfig) {
  if (!litConfig) {
    return null;
  }

  const pkpEthAddress = litConfig.pkpEthAddress ? getAddress(litConfig.pkpEthAddress) : null;

  return {
    provider: litConfig.provider ?? "chipotle",
    network: litConfig.network ?? null,
    pkpId: litConfig.pkpId ? String(litConfig.pkpId) : null,
    pkpRegistryId: litConfig.pkpRegistryId ? String(litConfig.pkpRegistryId) : null,
    actionIpfsCid: litConfig.actionIpfsCid,
    actionCode: litConfig.actionCode,
    actionCodeHash: litConfig.actionCodeHash,
    usageApiKey: litConfig.usageApiKey ?? null,
    groupId: litConfig.groupId ? String(litConfig.groupId) : null,
    pkpEthAddress,
    encryptedInferenceConfig: {
      ...litConfig.encryptedInferenceConfig,
    },
  };
}

export function smartWalletFeatureReady() {
  return (
    isAddress(SMART_WALLET_FACTORY_ADDRESS) &&
    SMART_WALLET_FACTORY_ADDRESS !== ZERO_ADDRESS &&
    SMART_WALLET_FACTORY_DEPLOYMENT_BLOCK > 0n
  );
}

export function normalizeSmartWalletRecord(record) {
  const walletAddress = getAddress(record.walletAddress);
  const owners = record.owners.map((owner) => getAddress(owner));
  const litConfig = normalizeLitConfig(record.litConfig);

  return {
    walletAddress,
    owners,
    salt: normalizeSalt(record.salt),
    deployed: Boolean(record.deployed),
    createdAtBlock: Number(record.createdAtBlock ?? 0),
    sourceFactory: getAddress(
      record.sourceFactory ??
        (record.kind === "lit" ? SMART_WALLET_FACTORY_ADDRESS : LEGACY_SMART_WALLET_FACTORY_ADDRESS),
    ),
    chainId: Number(record.chainId ?? CHAIN.id),
    txHash: record.txHash ?? null,
    kind: record.kind === "lit" ? "lit" : "legacy",
    supportsExecution:
      typeof record.supportsExecution === "boolean"
        ? record.supportsExecution
        : record.kind === "lit",
    litConfig,
  };
}

export function mergeSmartWalletRecords(records) {
  const byAddress = new Map();

  records.forEach((record) => {
    const normalized = normalizeSmartWalletRecord(record);
    const key = normalized.walletAddress.toLowerCase();
    const existing = byAddress.get(key);

    if (!existing) {
      byAddress.set(key, normalized);
      return;
    }

    byAddress.set(key, {
      ...existing,
      ...normalized,
      kind: normalized.kind === "lit" || existing.kind === "lit" ? "lit" : "legacy",
      supportsExecution: normalized.supportsExecution || existing.supportsExecution,
      litConfig: normalized.litConfig ?? existing.litConfig ?? null,
      txHash: normalized.txHash ?? existing.txHash ?? null,
      createdAtBlock: Math.max(existing.createdAtBlock, normalized.createdAtBlock),
    });
  });

  return [...byAddress.values()].sort((left, right) => right.createdAtBlock - left.createdAtBlock);
}

export async function createSmartWallet({
  account,
  coSignerAddress,
  kind = "legacy",
  litConfig = null,
  onDebugEvent,
}) {
  try {
    ensureFactoryReady();

    if (!isAddress(coSignerAddress)) {
      throw new Error("The second signer address is invalid.");
    }

    const owner1 = getAddress(account.address);
    const owner2 = getAddress(coSignerAddress.trim());
    if (owner1 === owner2) {
      throw new Error("The Lit PKP must be different from the current wallet.");
    }

    const owners = [owner1, owner2];
    const salt = createSalt();
    emitDebugEvent(onDebugEvent, {
      step: "createSmartWallet",
      status: "start",
      detail: {
        owner1,
        owner2,
        kind,
        salt: normalizeSalt(salt),
      },
    });
    const walletAddress = await publicClient.readContract({
      address: SMART_WALLET_FACTORY_ADDRESS,
      abi: SMART_WALLET_FACTORY_ABI,
      functionName: "getAddress",
      args: [owners, salt],
    });
    const walletClient = walletClientFor(account);
    const data = encodeFunctionData({
      abi: SMART_WALLET_FACTORY_ABI,
      functionName: "createAccount",
      args: [owners, salt],
    });
    emitDebugEvent(onDebugEvent, {
      step: "factoryPreview",
      status: "success",
      detail: {
        factoryAddress: SMART_WALLET_FACTORY_ADDRESS,
        walletAddress,
      },
    });
    const hash = await walletClient.sendTransaction({
      to: SMART_WALLET_FACTORY_ADDRESS,
      data,
    });
    emitDebugEvent(onDebugEvent, {
      step: "factoryCreateAccountTx",
      status: "success",
      detail: {
        hash,
        walletAddress,
      },
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const deployed = await hasDeployedCode(walletAddress);

    const record = normalizeSmartWalletRecord({
      walletAddress,
      owners,
      salt,
      deployed,
      createdAtBlock: receipt.blockNumber,
      sourceFactory: SMART_WALLET_FACTORY_ADDRESS,
      chainId: CHAIN.id,
      txHash: hash,
      kind,
      supportsExecution: true,
      litConfig,
    });
    emitDebugEvent(onDebugEvent, {
      step: "createSmartWallet",
      status: "success",
      detail: {
        walletAddress,
        blockNumber: receipt.blockNumber.toString(),
        txHash: hash,
        deployed,
      },
    });
    return record;
  } catch (error) {
    emitDebugEvent(onDebugEvent, {
      step: "createSmartWallet",
      status: "error",
      detail: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

async function discoverForFactory(factoryConfig, signer) {
  const logs = await publicClient.getLogs({
    address: factoryConfig.address,
    event: walletCreatedEvent,
    fromBlock: factoryConfig.fromBlock,
    toBlock: "latest",
  });

  return Promise.all(
    logs
      .filter((log) => {
        const owner1 = getAddress(log.args.owner1);
        const owner2 = getAddress(log.args.owner2);

        return owner1 === signer || owner2 === signer;
      })
      .map(async (log) => {
        const walletAddress = getAddress(log.args.wallet);
        const owners = (await readWalletOwners(walletAddress)) ?? [
          getAddress(log.args.owner1),
          getAddress(log.args.owner2),
        ];
        const deployed = await hasDeployedCode(walletAddress);

        return normalizeSmartWalletRecord({
          walletAddress,
          owners,
          salt: log.args.salt,
          deployed,
          createdAtBlock: log.blockNumber,
          sourceFactory: factoryConfig.address,
          chainId: CHAIN.id,
          kind: factoryConfig.mode === "lit" ? "lit" : "legacy",
          supportsExecution: factoryConfig.mode === "lit" ? await supportsExecution(walletAddress) : false,
        });
      }),
  );
}

export async function discoverSmartWalletsForSigner(signerAddress) {
  const signer = getAddress(signerAddress);
  const factories = activeFactories();

  if (!factories.length) {
    return [];
  }

  const discoveredGroups = await Promise.all(factories.map((factory) => discoverForFactory(factory, signer)));
  return mergeSmartWalletRecords(discoveredGroups.flat());
}

export async function executeSmartWalletSend({
  account,
  smartWallet,
  asset,
  recipient,
  amount,
  inputs,
  localVaultPassword,
  onDebugEvent,
  onProgressEvent,
}) {
  try {
    if (!smartWallet?.litConfig) {
      throw new Error("This smart wallet does not have Lit signer metadata, so it stays view-only.");
    }

    if (
      !smartWallet.litConfig.pkpId ||
      !smartWallet.litConfig.usageApiKey ||
      !smartWallet.litConfig.actionCode ||
      !smartWallet.litConfig.encryptedInferenceConfig?.ciphertext
    ) {
      throw new Error(
        "This wallet was created with legacy plaintext Lit metadata. Recreate the wallet so Lit can decrypt encrypted secrets during send.",
      );
    }

    const call = buildSmartWalletCall(asset, recipient, amount);
    emitDebugEvent(onDebugEvent, {
      step: "executeSmartWalletSend",
      status: "start",
      detail: {
        walletAddress: smartWallet.walletAddress,
        assetId: asset.id,
        recipient: call.target,
        value: call.value.toString(),
        hasData: call.data !== "0x",
      },
    });
    emitProgressEvent(onProgressEvent, {
      step: "buildExecution",
      status: "running",
    });
    const executionNonce = await publicClient.readContract({
      address: smartWallet.walletAddress,
      abi: SMART_WALLET_ABI,
      functionName: "nonce",
    });
    const executionHash = await publicClient.readContract({
      address: smartWallet.walletAddress,
      abi: SMART_WALLET_ABI,
      functionName: "getExecutionHash",
      args: [call.target, call.value, call.data, executionNonce],
    });
    emitDebugEvent(onDebugEvent, {
      step: "executionHash",
      status: "success",
      detail: {
        executionNonce: executionNonce.toString(),
        executionHash,
      },
    });
    emitProgressEvent(onProgressEvent, {
      step: "buildExecution",
      status: "success",
    });

    emitProgressEvent(onProgressEvent, {
      step: "userSignature",
      status: "running",
    });
    const signerOneSignature = await account.sign({
      hash: executionHash,
    });
    emitDebugEvent(onDebugEvent, {
      step: "signerOneSignature",
      status: "success",
      detail: {
        hasSignature: Boolean(signerOneSignature),
      },
    });
    emitProgressEvent(onProgressEvent, {
      step: "userSignature",
      status: "success",
    });

    const signerOneAddress = getAddress(account.address);
    const litSignerAddress = getAddress(
      smartWallet.litConfig.pkpEthAddress ?? smartWallet.litConfig.pkpId,
    );
    const ownersByLowercase = new Set(smartWallet.owners.map((owner) => owner.toLowerCase()));
    if (
      !ownersByLowercase.has(signerOneAddress.toLowerCase()) ||
      !ownersByLowercase.has(litSignerAddress.toLowerCase())
    ) {
      throw new Error(
        "The selected wallet owners do not match the unlocked user and Lit PKP signer. Recreate or re-sync this wallet before sending.",
      );
    }

    const litDecision = await requestLitSignature({
      account,
      litConfig: smartWallet.litConfig,
      executionHash,
      inputs,
      localVaultPassword,
      onDebugEvent,
      onProgressEvent,
    });

    if (!litDecision.approved || !litDecision.signature) {
      const inferenceBlocked =
        litDecision.failedStage === "inference" || litDecision.failedStage === "policy";
      const predictionLabel =
        litDecision.prediction === null ? "unavailable" : String(litDecision.prediction);
      const refusalError = new Error(
        inferenceBlocked
          ? "Possible signs of stress or coercion detected — Lit PKP refused to sign."
          : litDecision.reason ||
            `Lit denied the transaction because the inference result was ${predictionLabel}.`,
      );
      refusalError.failedStage = litDecision.failedStage ?? "execution";
      throw refusalError;
    }

    const signaturesByOwner = new Map([
      [signerOneAddress.toLowerCase(), signerOneSignature],
      [litSignerAddress.toLowerCase(), litDecision.signature],
    ]);
    const orderedSignatures = smartWallet.owners.map((owner) => {
      const signature = signaturesByOwner.get(owner.toLowerCase());
      if (!signature) {
        throw new Error(
          `Missing signature for owner ${owner}. The wallet owner set does not match the expected signers.`,
        );
      }

      return signature;
    });

    const walletClient = walletClientFor(account);
    emitProgressEvent(onProgressEvent, {
      step: "submitTransaction",
      status: "running",
    });
    const hash = await walletClient.sendTransaction({
      to: smartWallet.walletAddress,
      data: encodeFunctionData({
        abi: SMART_WALLET_ABI,
        functionName: "execute",
        args: [call.target, call.value, call.data, executionNonce, orderedSignatures],
      }),
    });
    emitProgressEvent(onProgressEvent, {
      step: "submitTransaction",
      status: "success",
      detail: {
        hash,
      },
    });
    emitProgressEvent(onProgressEvent, {
      step: "waitConfirmation",
      status: "running",
    });
    await publicClient.waitForTransactionReceipt({ hash });
    emitProgressEvent(onProgressEvent, {
      step: "waitConfirmation",
      status: "success",
    });
    emitDebugEvent(onDebugEvent, {
      step: "executeSmartWalletTx",
      status: "success",
      detail: {
        hash,
        walletAddress: smartWallet.walletAddress,
      },
    });

    return {
      hash,
      explorerUrl: `${EXPLORER_TX_BASE_URL}${hash}`,
      prediction: litDecision.prediction,
      probability: litDecision.probability,
      target: litDecision.target,
    };
  } catch (error) {
    const failedStage = error?.failedStage ?? null;
    if (failedStage === "decrypt") {
      emitProgressEvent(onProgressEvent, {
        step: "litDecrypt",
        status: "error",
        detail: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } else if (failedStage === "inference" || failedStage === "policy") {
      emitProgressEvent(onProgressEvent, {
        step: "litInference",
        status: "error",
        detail: {
          message: "Possible signs of stress or coercion detected — Lit PKP refused to sign.",
        },
      });
    } else if (failedStage === "sign") {
      emitProgressEvent(onProgressEvent, {
        step: "litSignature",
        status: "error",
        detail: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } else {
      emitProgressEvent(onProgressEvent, {
        step: "submitTransaction",
        status: "error",
        detail: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }

    emitDebugEvent(onDebugEvent, {
      step: "executeSmartWalletSend",
      status: "error",
      detail: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export function getSmartWalletFactorySummary() {
  return {
    factoryAddress: SMART_WALLET_FACTORY_ADDRESS,
    entryPointAddress: ENTRY_POINT_ADDRESS,
    deploymentBlock: Number(SMART_WALLET_FACTORY_DEPLOYMENT_BLOCK),
    legacyFactoryAddress: LEGACY_SMART_WALLET_FACTORY_ADDRESS,
    legacyDeploymentBlock: Number(LEGACY_SMART_WALLET_FACTORY_DEPLOYMENT_BLOCK),
  };
}
