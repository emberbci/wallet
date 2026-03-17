export function parseActionResponse(result) {
  let response = result?.response ?? null;
  if (typeof response === "string") {
    try {
      response = JSON.parse(response);
    } catch (error) {
      response = null;
    }
  }

  return {
    hasError: Boolean(result?.has_error),
    logs: result?.logs ?? "",
    response,
  };
}

export function getLitActionCode() {
  return `
async function main(input) {
  const LitActions = Lit.Actions;
  const { ethers } = globalThis;
  const params =
    input ??
    (typeof jsParams !== "undefined"
      ? jsParams
      : typeof js_params !== "undefined"
        ? js_params
        : {});
  let stage = "execution";

  try {
    if (params.op === "init") {
      return {
        ok: true,
        storageMode: "lit_ciphertext",
      };
    }

    if (params.op === "encrypt_config") {
      stage = "encrypt";
      const secretConfig =
        params.secretConfig && typeof params.secretConfig === "object"
          ? params.secretConfig
          : typeof params.secretConfig === "string"
            ? JSON.parse(params.secretConfig)
            : null;

      if (!secretConfig?.endpoint || !secretConfig?.apiKey || !secretConfig?.deploymentId) {
        return {
          ok: false,
          failedStage: "encrypt",
          reason: "Missing inference configuration for Lit-backed signing.",
        };
      }

      if (typeof LitActions.encrypt !== "function") {
        return {
          ok: false,
          failedStage: "encrypt",
          reason: "Lit encryption is unavailable in this runtime (LitActions.encrypt is not a function).",
        };
      }

      const ciphertext = await LitActions.encrypt({
        pkpId: params.pkpId,
        message: JSON.stringify(secretConfig),
      });

      return {
        ok: true,
        storageMode: "lit_ciphertext",
        ciphertext,
      };
    }

    if (params.op !== "sign") {
      return {
        approved: false,
        failedStage: "execution",
        reason: \`Unsupported action op: \${params.op}\`,
      };
    }

    stage = "decrypt";
    let secretConfig =
      params.secretConfig && typeof params.secretConfig === "object"
        ? params.secretConfig
        : typeof params.secretConfig === "string"
          ? JSON.parse(params.secretConfig)
          : null;

    if (!secretConfig) {
      if (!params.ciphertext) {
        return {
          approved: false,
          failedStage: "decrypt",
          prediction: null,
          reason: "Missing encrypted inference configuration for Lit-backed signing.",
        };
      }

      if (typeof LitActions.decrypt !== "function") {
        return {
          approved: false,
          failedStage: "decrypt",
          prediction: null,
          reason: "Lit decryption is unavailable in this runtime (LitActions.decrypt is not a function).",
        };
      }

      const decrypted = await LitActions.decrypt({
        pkpId: params.pkpId,
        ciphertext: params.ciphertext,
      });

      try {
        secretConfig =
          decrypted && typeof decrypted === "string" ? JSON.parse(decrypted) : null;
      } catch (error) {
        secretConfig = null;
      }
    }

    if (!secretConfig?.endpoint || !secretConfig?.apiKey || !secretConfig?.deploymentId) {
      return {
        approved: false,
        failedStage: "decrypt",
        prediction: null,
        reason: "Could not decrypt a valid inference configuration for Lit-backed signing.",
      };
    }

    stage = "inference";
    const response = await fetch(\`\${secretConfig.endpoint}/infer\`, {
      method: "POST",
      headers: {
        Authorization: \`Bearer \${secretConfig.apiKey}\`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        deployment_id: secretConfig.deploymentId,
        inputs: params.inputs,
      }),
    });

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      payload = { error: "The inference API did not return valid JSON." };
    }

    const inferenceResult = {
      ok: response.ok,
      status: response.status,
      payload,
    };
    const prediction = Number(inferenceResult?.payload?.prediction);

    if (!inferenceResult?.ok) {
      return {
        approved: false,
        failedStage: "inference",
        prediction: Number.isFinite(prediction) ? prediction : null,
        reason: \`Inference API request failed with status \${inferenceResult?.status ?? "unknown"}.\`,
        payload: inferenceResult?.payload ?? null,
      };
    }

    if (prediction !== 1) {
      return {
        approved: false,
        failedStage: "policy",
        prediction,
        probability: inferenceResult?.payload?.probability ?? null,
        target: inferenceResult?.payload?.target ?? null,
      };
    }

    stage = "sign";
    const privateKey = await LitActions.getPrivateKey({
      pkpId: params.pkpId,
    });
    const wallet = new ethers.Wallet(privateKey);
    const digest = params.executionHash;
    const signingKey = wallet._signingKey ? wallet._signingKey() : wallet.signingKey;
    const signedDigest = signingKey.signDigest
      ? signingKey.signDigest(digest)
      : signingKey.sign(digest);
    const signature = signedDigest.serialized ?? ethers.utils.joinSignature(signedDigest);

    return {
      approved: true,
      failedStage: null,
      prediction,
      probability: inferenceResult?.payload?.probability ?? null,
      target: inferenceResult?.payload?.target ?? null,
      signature,
    };
  } catch (error) {
    return {
      approved: false,
      failedStage:
        stage === "encrypt"
          ? "encrypt"
          : stage === "decrypt"
          ? "decrypt"
          : stage === "inference"
            ? "inference"
            : stage === "sign"
              ? "sign"
              : "execution",
      prediction: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
`;
}
