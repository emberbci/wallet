import { LIT_API_BASE_URL } from "../../config.js";
import { emitLitDebugEvent } from "./events.js";
import { normalizeLitApiError } from "./errors.js";

const DEFAULT_PAGE_SIZE = 100;

export function normalizeApiKeyInput(apiKey) {
  const trimmed = apiKey?.trim() ?? "";
  return trimmed.replace(/^Bearer\s+/i, "").trim();
}

async function litApiRequest({
  path,
  method = "GET",
  apiKey,
  body,
  onDebugEvent,
}) {
  const headers = {
    Accept: "application/json",
  };

  if (apiKey) {
    headers["X-Api-Key"] = normalizeApiKeyInput(apiKey);
  }

  const init = {
    method,
    headers,
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response;

  try {
    emitLitDebugEvent(onDebugEvent, {
      step: path,
      status: "request",
      detail: {
        method,
        path,
        hasApiKey: Boolean(apiKey),
        body: body ?? null,
      },
    });
    response = await fetch(`${LIT_API_BASE_URL}${path}`, init);
  } catch (error) {
    const requestError = new Error(
      `Could not reach the Lit Chipotle API at ${LIT_API_BASE_URL}. Check your network connection and extension host permissions.`,
    );
    requestError.cause = error;
    emitLitDebugEvent(onDebugEvent, {
      step: path,
      status: "error",
      detail: {
        method,
        path,
        message: requestError.message,
      },
    });
    throw requestError;
  }

  const raw = await response.text();
  let payload = null;

  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      payload = raw;
    }
  }

  if (!response.ok) {
    const error = normalizeLitApiError(path, response, payload);
    emitLitDebugEvent(onDebugEvent, {
      step: path,
      status: "error",
      detail: {
        method,
        path,
        status: response.status,
        payload,
      },
    });
    throw error;
  }

  emitLitDebugEvent(onDebugEvent, {
    step: path,
    status: "success",
    detail: {
      method,
      path,
      status: response.status,
      payload,
    },
  });
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function accountExists(apiKey, options = {}) {
  return litApiRequest({
    path: "/account_exists",
    apiKey,
    ...options,
  });
}

export async function getBillingBalance(apiKey, options = {}) {
  return litApiRequest({
    path: "/billing/balance",
    apiKey,
    ...options,
  });
}

export async function createWallet(apiKey, options = {}) {
  return litApiRequest({
    path: "/create_wallet",
    apiKey,
    ...options,
  });
}

async function listWallets(apiKey, options = {}) {
  const params = new URLSearchParams({
    page_number: "0",
    page_size: String(DEFAULT_PAGE_SIZE),
  });

  return litApiRequest({
    path: `/list_wallets?${params.toString()}`,
    apiKey,
    ...options,
  });
}

export async function findWalletByAddress(apiKey, walletAddress, attempts = 5, options = {}) {
  const expectedAddress = walletAddress.toLowerCase();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const wallets = await listWallets(apiKey, options);
    const match = wallets.find((wallet) => wallet.wallet_address.toLowerCase() === expectedAddress);

    if (match) {
      return match;
    }

    if (attempt < attempts - 1) {
      await sleep(750);
    }
  }

  throw new Error("Chipotle created the PKP wallet but it was not returned by list_wallets yet.");
}

export async function getLitActionIpfsId(actionCode, options = {}) {
  return litApiRequest({
    path: "/get_lit_action_ipfs_id",
    method: "POST",
    body: actionCode,
    ...options,
  });
}

export async function addGroup(apiKey, payload, options = {}) {
  return litApiRequest({
    path: "/add_group",
    method: "POST",
    apiKey,
    body: payload,
    ...options,
  });
}

export async function addActionToGroup(apiKey, payload, options = {}) {
  return litApiRequest({
    path: "/add_action_to_group",
    method: "POST",
    apiKey,
    body: payload,
    ...options,
  });
}

export async function addPkpToGroup(apiKey, payload, options = {}) {
  return litApiRequest({
    path: "/add_pkp_to_group",
    method: "POST",
    apiKey,
    body: payload,
    ...options,
  });
}

export async function addUsageApiKey(apiKey, payload, options = {}) {
  return litApiRequest({
    path: "/add_usage_api_key",
    method: "POST",
    apiKey,
    body: payload,
    ...options,
  });
}

export async function executeLitAction(apiKey, payload, options = {}) {
  const normalizedPayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? {
          ...payload,
          jsParams: payload.jsParams ?? payload.js_params ?? {},
          js_params: payload.js_params ?? payload.jsParams ?? {},
        }
      : payload;

  return litApiRequest({
    path: "/lit_action",
    method: "POST",
    apiKey,
    body: normalizedPayload,
    ...options,
  });
}
