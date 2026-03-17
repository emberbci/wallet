import { parseActionResponse } from "./action-runtime.js";
import { emitLitDebugEvent, emitLitProgressEvent } from "./events.js";
import { openInferenceConfig } from "./local-config.js";
import {
  executeLitActionWithRetry,
  PKP_READY_RETRY_ATTEMPTS,
  PKP_READY_RETRY_DELAY_MS,
} from "./retry.js";

export async function requestLitSignature({
  litConfig,
  executionHash,
  inputs,
  localVaultPassword,
  onDebugEvent,
  onProgressEvent,
}) {
  emitLitDebugEvent(onDebugEvent, {
    step: "requestLitSignature",
    status: "start",
    detail: {
      pkpId: litConfig.pkpId,
      executionHash,
    },
  });
  emitLitProgressEvent(onProgressEvent, {
    step: "litDecrypt",
    status: "running",
  });

  const encryptedInferenceConfig = litConfig.encryptedInferenceConfig ?? {};
  const localConfigMode = encryptedInferenceConfig.storageMode === "local_aes_gcm_v1";
  const jsParams = {
    op: "sign",
    pkpId: litConfig.pkpId,
    executionHash,
    inputs,
  };

  let decryptedLocally = false;
  if (localConfigMode) {
    try {
      jsParams.secretConfig = await openInferenceConfig(encryptedInferenceConfig, {
        password: localVaultPassword,
        pkpId: litConfig.pkpId,
      });
    } catch (error) {
      const decryptError = new Error(error instanceof Error ? error.message : String(error));
      decryptError.failedStage = "decrypt";
      throw decryptError;
    }
    decryptedLocally = true;
    emitLitProgressEvent(onProgressEvent, { step: "litDecrypt", status: "success" });
  } else {
    jsParams.ciphertext = encryptedInferenceConfig.ciphertext;
  }

  const execution = await executeLitActionWithRetry(
    litConfig.usageApiKey,
    {
      code: litConfig.actionCode,
      jsParams,
    },
    {
      attempts: PKP_READY_RETRY_ATTEMPTS,
      delayMs: PKP_READY_RETRY_DELAY_MS,
      onDebugEvent,
    },
  );
  const result = parseActionResponse(execution);
  const response = result.response ?? {};
  const signature = typeof response.signature === "string" ? response.signature : null;

  const decision = {
    approved: Boolean(response.approved) && Boolean(signature),
    failedStage: response.failedStage ?? (result.hasError ? "execution" : null),
    prediction: response.prediction ?? null,
    probability: response.probability ?? null,
    target: response.target ?? null,
    reason: response.reason ?? (result.hasError ? "Lit Action execution failed." : ""),
    signature,
  };
  emitLitDebugEvent(onDebugEvent, {
    step: "requestLitSignature",
    status: decision.approved ? "success" : "error",
    detail: {
      approved: decision.approved,
      prediction: decision.prediction,
      probability: decision.probability,
      target: decision.target,
      reason: decision.reason,
      hasSignature: Boolean(decision.signature),
    },
  });

  if (decision.approved) {
    if (!decryptedLocally) {
      emitLitProgressEvent(onProgressEvent, { step: "litDecrypt", status: "success" });
    }
    emitLitProgressEvent(onProgressEvent, { step: "litInference", status: "success" });
    emitLitProgressEvent(onProgressEvent, { step: "litSignature", status: "success" });
    return decision;
  }

  if (decision.failedStage === "decrypt") {
    emitLitProgressEvent(onProgressEvent, {
      step: "litDecrypt",
      status: "error",
      detail: {
        message: decision.reason,
      },
    });
    return decision;
  }

  if (!decryptedLocally) {
    emitLitProgressEvent(onProgressEvent, { step: "litDecrypt", status: "success" });
  }

  if (decision.failedStage === "inference" || decision.failedStage === "policy") {
    emitLitDebugEvent(onDebugEvent, {
      step: "litInference",
      status: "blocked",
      detail: "Possible signs of stress or coercion detected — Lit PKP refused to sign.",
    });
    emitLitProgressEvent(onProgressEvent, {
      step: "litInference",
      status: "error",
      detail: {
        message: "Possible signs of stress or coercion detected — Lit PKP refused to sign.",
        prediction: decision.prediction,
      },
    });
    return decision;
  }

  if (decision.failedStage === "sign") {
    emitLitProgressEvent(onProgressEvent, { step: "litInference", status: "success" });
    emitLitProgressEvent(onProgressEvent, {
      step: "litSignature",
      status: "error",
      detail: {
        message: decision.reason,
      },
    });
    return decision;
  }

  emitLitProgressEvent(onProgressEvent, {
    step: "litInference",
    status: "error",
    detail: {
      message: "Possible signs of stress or coercion detected — Lit PKP refused to sign.",
    },
  });
  return decision;
}
