import { executeLitAction } from "./api.js";
import { emitLitDebugEvent } from "./events.js";

export const PKP_READY_RETRY_ATTEMPTS = 8;
export const PKP_READY_RETRY_DELAY_MS = 1500;

function isRetryablePkpError(error) {
  const message = error instanceof Error ? error.message : String(error);

  return (
    message.includes("Invalid PKP ID") ||
    message.includes("PKP not found") ||
    message.includes("wallet not found") ||
    message.includes("not authorized to execute the specified action")
  );
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function executeLitActionWithRetry(
  apiKey,
  payload,
  { attempts = 1, delayMs = 0, onDebugEvent } = {},
) {
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await executeLitAction(apiKey, payload, { onDebugEvent });
    } catch (error) {
      lastError = error;

      if (!isRetryablePkpError(error) || attempt === attempts - 1) {
        throw error;
      }

      emitLitDebugEvent(onDebugEvent, {
        step: "/lit_action",
        status: "retry",
        detail: {
          attempt: attempt + 1,
          remaining: attempts - attempt - 1,
          delayMs,
          message: error instanceof Error ? error.message : String(error),
        },
      });
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("Lit action execution failed.");
}
