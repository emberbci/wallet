import { LIT_DASHBOARD_URL, LIT_INFERENCE_ENDPOINT, LIT_NETWORK } from "../../config.js";
import { getAddress, keccak256, stringToHex } from "viem";

import {
  accountExists,
  addActionToGroup,
  addGroup,
  addPkpToGroup,
  addUsageApiKey,
  createWallet,
  findWalletByAddress,
  getBillingBalance,
  getLitActionIpfsId,
  normalizeApiKeyInput,
} from "./api.js";
import { getLitActionCode, parseActionResponse } from "./action-runtime.js";
import { emitLitDebugEvent } from "./events.js";
import { normalizeChipotleSetupError } from "./errors.js";
import { sealInferenceConfig } from "./local-config.js";
import {
  executeLitActionWithRetry,
  PKP_READY_RETRY_ATTEMPTS,
  PKP_READY_RETRY_DELAY_MS,
} from "./retry.js";

function buildGroupName(accountAddress) {
  return `Ember ${accountAddress.slice(0, 6)} ${Date.now().toString(36)}`;
}

export async function createLitBackedSigner({
  account,
  litAccountApiKey,
  deploymentId,
  apiKey,
  localVaultPassword,
  onDebugEvent,
}) {
  if (!litAccountApiKey?.trim()) {
    throw new Error("Enter a Lit Chipotle account API key.");
  }

  if (!deploymentId?.trim()) {
    throw new Error("Enter a deployment ID for the Lit-backed wallet.");
  }

  if (!apiKey?.trim()) {
    throw new Error("Enter an API key for the Lit-backed wallet.");
  }

  const accountApiKey = normalizeApiKeyInput(litAccountApiKey);

  try {
    emitLitDebugEvent(onDebugEvent, {
      step: "createLitBackedSigner",
      status: "start",
      detail: {
        accountAddress: account.address,
        network: LIT_NETWORK,
      },
    });

    const exists = await accountExists(accountApiKey, { onDebugEvent });
    if (!exists) {
      throw new Error("The supplied Lit Chipotle account key does not belong to an active account.");
    }

    const billing = await getBillingBalance(accountApiKey, { onDebugEvent }).catch(() => null);
    if (billing && Number(billing.balance_cents) === 0) {
      throw new Error(
        `Lit Chipotle account credits are exhausted. Add funds in ${LIT_DASHBOARD_URL} and retry.`,
      );
    }

    const actionCode = getLitActionCode();
    emitLitDebugEvent(onDebugEvent, {
      step: "prepareActionCode",
      status: "success",
      detail: {
        actionCodeHash: keccak256(stringToHex(actionCode)),
      },
    });
    const actionIpfsCid = await getLitActionIpfsId(actionCode, { onDebugEvent });
    const createdWallet = await createWallet(accountApiKey, { onDebugEvent });
    const pkpEthAddress = getAddress(createdWallet.wallet_address);
    const pkpWallet = await findWalletByAddress(accountApiKey, pkpEthAddress, 5, { onDebugEvent });
    const pkpRegistryId = String(pkpWallet.id);
    emitLitDebugEvent(onDebugEvent, {
      step: "walletResolved",
      status: "success",
      detail: {
        pkpEthAddress,
        pkpRegistryId,
      },
    });
    const groupPayload = {
      group_name: buildGroupName(account.address),
      group_description: `Ember wallet policy group for ${account.address}`,
      pkp_ids_permitted: [],
      cid_hashes_permitted: [],
    };
    const group = await addGroup(accountApiKey, groupPayload, { onDebugEvent });
    const groupId = String(group.group_id);
    const groupIdNumber = Number(groupId);

    await addActionToGroup(accountApiKey, {
      group_id: groupIdNumber,
      action_ipfs_cid: actionIpfsCid,
    }, {
      onDebugEvent,
    });
    await addPkpToGroup(accountApiKey, {
      group_id: groupIdNumber,
      pkp_id: pkpEthAddress,
    }, {
      onDebugEvent,
    });

    const usageKey = await addUsageApiKey(accountApiKey, {
      name: `Ember execute ${pkpEthAddress.slice(0, 10)}`,
      description: `Execution key for Ember smart wallet backed by PKP ${pkpEthAddress}`,
      can_create_groups: false,
      can_delete_groups: false,
      can_create_pkps: false,
      manage_ipfs_ids_in_groups: [],
      add_pkp_to_groups: [],
      remove_pkp_from_groups: [],
      execute_in_groups: [groupIdNumber],
    }, {
      onDebugEvent,
    });

    emitLitDebugEvent(onDebugEvent, {
      step: "initExecutionKey",
      status: "success",
      detail: {
        mode: "usage_api_key",
        groupId,
      },
    });

    const encryptionExecution = await executeLitActionWithRetry(
      usageKey.usage_api_key,
      {
        code: actionCode,
        jsParams: {
          op: "encrypt_config",
          pkpId: pkpEthAddress,
          secretConfig: {
            endpoint: LIT_INFERENCE_ENDPOINT,
            apiKey: apiKey.trim(),
            deploymentId: deploymentId.trim(),
          },
        },
      },
      {
        attempts: PKP_READY_RETRY_ATTEMPTS,
        delayMs: PKP_READY_RETRY_DELAY_MS,
        onDebugEvent,
      },
    );
    const encryptionResult = parseActionResponse(encryptionExecution);
    const encryptionResponse = encryptionResult.response ?? {};
    const secretConfig = {
      endpoint: LIT_INFERENCE_ENDPOINT,
      apiKey: apiKey.trim(),
      deploymentId: deploymentId.trim(),
    };

    let encryptedInferenceConfig = null;
    if (encryptionResponse.ok && typeof encryptionResponse.ciphertext === "string") {
      encryptedInferenceConfig = {
        ciphertext: encryptionResponse.ciphertext,
        storageMode: encryptionResponse.storageMode ?? "lit_ciphertext",
        endpointVersion: 2,
      };
    } else if (
      typeof encryptionResponse.reason === "string" &&
      encryptionResponse.reason.includes("LitActions.encrypt is not a function")
    ) {
      const localSealed = await sealInferenceConfig(secretConfig, {
        password: localVaultPassword,
        pkpId: pkpEthAddress,
      });
      encryptedInferenceConfig = {
        ...localSealed,
        endpointVersion: 2,
      };
    } else {
      throw new Error(
        encryptionResponse.reason ||
          "Lit could not encrypt the smart-wallet inference configuration.",
      );
    }

    emitLitDebugEvent(onDebugEvent, {
      step: "encryptInferenceConfig",
      status: "success",
      detail: {
        storageMode: encryptedInferenceConfig.storageMode ?? null,
        ciphertextLength: encryptedInferenceConfig.ciphertext.length,
      },
    });

    const litConfig = {
      provider: "chipotle",
      network: LIT_NETWORK,
      pkpId: pkpEthAddress,
      pkpRegistryId,
      pkpEthAddress,
      groupId,
      actionIpfsCid,
      actionCode,
      actionCodeHash: keccak256(stringToHex(actionCode)),
      usageApiKey: usageKey.usage_api_key,
      encryptedInferenceConfig,
    };
    emitLitDebugEvent(onDebugEvent, {
      step: "createLitBackedSigner",
      status: "success",
      detail: {
        pkpEthAddress,
        pkpRegistryId,
        groupId,
        actionIpfsCid,
      },
    });
    return litConfig;
  } catch (error) {
    emitLitDebugEvent(onDebugEvent, {
      step: "createLitBackedSigner",
      status: "error",
      detail: {
        message: error instanceof Error ? error.message : String(error),
        path: error?.litPath ?? null,
        statusCode: error?.statusCode ?? null,
        payload: error?.payload ?? null,
      },
    });
    throw normalizeChipotleSetupError(error);
  }
}
