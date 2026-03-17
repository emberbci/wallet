import { LIT_DASHBOARD_URL } from "../../config.js";

export function describeLitPayload(payload) {
  if (payload == null) {
    return "";
  }

  if (typeof payload === "string") {
    return payload;
  }

  if (payload instanceof Error) {
    return payload.message;
  }

  if (typeof payload.message === "string") {
    return payload.message;
  }

  if (typeof payload.error === "string") {
    return payload.error;
  }

  try {
    return JSON.stringify(payload);
  } catch (error) {
    return String(payload);
  }
}

function createLitApiError(path, response, payload, fallbackMessage) {
  const error = new Error(fallbackMessage);
  error.litPath = path;
  error.statusCode = response?.status ?? null;
  error.payload = payload;
  return error;
}

export function normalizeLitApiError(path, response, payload) {
  const detail = describeLitPayload(payload);

  if (response.status === 401 || response.status === 403) {
    return createLitApiError(
      path,
      response,
      payload,
      detail || `Lit Chipotle rejected the supplied API key for ${path}.`,
    );
  }

  if (response.status === 402) {
    return createLitApiError(
      path,
      response,
      payload,
      `Lit Chipotle account credits are exhausted. Add funds in ${LIT_DASHBOARD_URL} and retry.`,
    );
  }

  return createLitApiError(
    path,
    response,
    payload,
    detail || `Lit Chipotle API request to ${path} failed with status ${response.status}.`,
  );
}

export function normalizeChipotleSetupError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const detail = describeLitPayload(error?.payload);

  if (error?.statusCode === 401 || error?.statusCode === 403) {
    if (error?.litPath === "/account_exists") {
      return new Error(
        "Lit rejected the supplied Chipotle account key. Paste the master account API key from the Chipotle dashboard. The field also accepts a full `Bearer ...` token and will strip the prefix automatically.",
      );
    }

    if (error?.litPath === "/lit_action") {
      return new Error(
        `Lit accepted the setup key, but execution for the configured action is not authorized yet.${detail ? ` Response: ${detail}` : ""}`,
      );
    }

    return new Error(
      `Lit denied ${error?.litPath ?? "this management request"} even though the key was accepted for the earlier checks. This setup flow needs a management-capable account API key, not a scoped usage key.${detail ? ` Response: ${detail}` : ""}`,
    );
  }

  if (message.includes("Lit Chipotle rejected the supplied API key")) {
    return new Error(
      "Lit rejected the supplied Chipotle account key. Paste the master account API key from the Chipotle dashboard.",
    );
  }

  if (message.includes("Invalid PKP ID")) {
    return new Error(
      "Lit Chipotle created the wallet, but the PKP is not usable yet. Retry in a few seconds.",
    );
  }

  return error instanceof Error ? error : new Error(message);
}
