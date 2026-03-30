# Ember Wallet

Ember is an anti-coercion smart contract wallet built for the intersection of neurotech, digital rights, and programmable cryptography. It is designed around one core idea: traditional wallets protect against remote attackers, but they do almost nothing when the threat is physical coercion. Ember adds a biometric panic check directly into the transaction flow, turning live cognitive state into a security condition before assets can move.

The current prototype is a browser extension wallet for Ethereum Sepolia. A user first creates or imports a normal wallet in the extension, then creates a Lit-backed smart wallet where their extension wallet is signer one and a Lit PKP is signer two. When the user wants to send funds from the smart wallet, Ember requires both signatures. The user signs locally, then uploads fresh BCI-derived readings in CSV form. A Lit Action securely decrypts the user’s Impulse AI inference configuration, sends the feature payload to the Impulse inference API, and only returns the second signature if the model approves the transaction. If the model detects stress, fear, panic, stale data, or an invalid result, the Lit signer refuses to sign and the transaction cannot execute.

## What Problem Ember Solves

Current wallets are highly effective at protecting keys from online theft, malware, and unauthorized remote access. They are far less effective against the five-dollar wrench attack, where an attacker physically pressures a user into unlocking a wallet and approving a transfer. In that scenario, the wallet cannot tell the difference between voluntary consent and forced approval.

Ember introduces a real-time neuro-biometric approval layer. Instead of trusting only possession of a private key, Ember requires evidence that the person approving the transaction is in a calm, non-coerced state. The result is a wallet model built around cognitive sovereignty and physical fail-safes, not just key custody.

## How It Works

Ember uses a 2-of-2 multisig smart wallet:

- Signer one is the user’s normal extension wallet.
- Signer two is a Lit PKP managed through Lit Protocol V1 on the Naga test network.

When the user creates a Lit-backed smart wallet:

1. The extension authenticates to Lit with the user’s wallet.
2. Ember mints a PKP that will act as the second signer.
3. Ember generates a dedicated Lit Action for that wallet.
4. The user provides an Impulse AI `deployment_id` and `apiKey`.
5. Ember encrypts `{ endpoint, deploymentId, apiKey }` with Lit access control conditions and stores only ciphertext plus metadata in the wallet vault.
6. The PKP address becomes signer two in the smart wallet deployed on Sepolia.

When the user sends a transaction from the smart wallet:

1. The user prepares a send and uploads a one-row CSV containing fresh BCI-derived features.
2. Ember parses the CSV into the inference input object expected by the Impulse AI endpoint.
3. Ember computes the smart-wallet execution hash and signs it locally with signer one.
4. Ember sends the execution hash, encrypted inference config, and parsed feature payload to the Lit Action.
5. Inside Lit’s execution environment, the Lit Action decrypts the Impulse credentials, calls the Impulse API, and checks the model output.
6. If `prediction === 1`, the Lit PKP signs the same execution hash and returns the second signature.
7. Ember submits the fully signed transaction to the smart wallet contract.
8. If the result is `0`, `-1`, invalid, stale, or the API call fails, the Lit Action refuses to sign and the transaction is blocked.

This means a coerced attacker can force a user to open the wallet, but they still cannot move assets unless the biometric and AI-based panic check passes.

## Why This Fits The Challenge Tracks

### NeuroTrack

Ember sits directly at the boundary of BCI, cognition, and computation. It treats neural or neuro-adjacent biometric readings as a security primitive, not just an analytics signal. The project is grounded in cognitive sovereignty: the user’s live mental state becomes part of the consent model for moving value. It also raises exactly the kinds of design questions the track highlights, including neural data rights, safe augmentation, freshness of cognitive data, and how neurotech should interact with high-stakes digital systems.

### Infrastructure & Digital Rights

Ember is also an infrastructure and digital-rights project. It uses decentralized key management, privacy-preserving secret handling, and programmable cryptography to give users stronger control over when value can leave their custody. Sensitive inference credentials are encrypted and are intended to be decrypted only inside Lit’s secure execution flow, rather than exposed to the extension or backend operators.

### Lit Protocol Challenge

This prototype demonstrably uses Lit Protocol V1 (Naga):

- PKPs for decentralized second-signer key management
- Lit Actions for programmable signing policy
- Lit encryption for protecting inference configuration

This is not a cosmetic integration. Lit is the core enforcement layer that decides whether the second signature exists at all.

### Impulse AI Challenge

Ember uses Impulse AI as a cognitive oracle in the transaction approval flow. The prototype is built around the Impulse-hosted inference endpoint pattern, where the model is deployed once and later called with feature inputs derived from CSV-based BCI readings. Impulse is what transforms raw biometric input into a transaction gating decision that the Lit Action can enforce cryptographically.

## Technical Architecture

### Extension Layer

The browser extension is the user-facing wallet shell. It handles:

- wallet creation and import
- encrypted local vault storage
- ETH and ERC-20 portfolio tracking
- smart-wallet creation and discovery
- CSV upload and parsing
- sending normal EOA transactions
- building smart-wallet execution payloads

The extension stores the base wallet in `chrome.storage.local` using AES-GCM encryption derived from the user’s password. It also stores Lit-backed wallet metadata and Lit-encrypted inference ciphertext. Plaintext Impulse credentials are not intended to be stored in extension storage after setup.

### Smart Wallet Layer

The smart wallet is a deterministic 2-of-2 wallet contract deployed via a factory on Sepolia. It has:

- exactly two owners
- a nonce-based `execute` path
- strict ordered-signature validation
- replay protection

The upgraded wallet executes arbitrary ETH or ERC-20 transfers only when both the user and the Lit PKP have signed the same execution hash.

### Lit Layer

Lit Protocol V1 on Naga provides:

- PKP generation for signer two
- Lit Action execution as the transaction policy engine
- encrypted inference secret storage
- programmable second-signature issuance

Each Lit-backed smart wallet gets its own Lit Action. That action is responsible for decrypting the Impulse configuration, invoking the inference API, evaluating the result, and producing the PKP signature only when the biometric approval condition is satisfied.

### Impulse AI Layer

Impulse AI is used as the inference engine that evaluates the uploaded biometric feature set. Ember currently expects a deployment that accepts feature inputs similar to:

- `mean_2_a`
- `mean_3_a`
- `fft_465_a`
- `fft_511_a`
- `fft_556_a`

Additional features may also be passed through. Missing supported features are sent as `null`.

The Impulse response is expected to include a `prediction` field, and the current prototype allows execution only when `prediction === 1`.

## Safety, Privacy, And Ethics

Ember is intentionally built around safety-sensitive assumptions:

- Biometric data is uploaded only at sign time and is not intended to be stored long term by the extension.
- Impulse inference credentials are encrypted for Lit-based access rather than kept as plain reusable config.
- The system is fail-closed. Any invalid result, stale data, API error, or denied prediction blocks the transaction.
- The architecture is explicitly designed around anti-coercion and cognitive liberty, not behavior profiling or continuous surveillance.

This is still an experimental prototype. It should be treated as a research system exploring how neurotech and decentralized cryptography can be combined responsibly in high-stakes financial workflows.

## Current Prototype Features

- Create a base wallet from a mnemonic
- Import a wallet from mnemonic or private key
- Encrypt the base wallet vault locally
- Track Sepolia ETH and manually added ERC-20 tokens
- Send ETH and ERC-20 tokens from the base wallet
- Discover smart wallets from configured factories
- Create Lit-backed smart wallets from the extension flow
- Upload a CSV and request Lit-gated approval for smart-wallet sends
- Block execution when the Lit/Impulse path does not approve

## Project Status

The Lit-backed wallet flow and upgraded smart-wallet execution path are implemented in the repo, but the upgraded Sepolia smart-wallet factory still needs to be deployed and configured before end-to-end Lit wallet creation is enabled in the UI.

Right now:

- legacy smart wallets can still be discovered
- the new Lit-backed creation flow is wired in
- the upgraded factory address in `src/smart-wallet-deployment.js` must be updated after deployment

## Repository Structure

- `src/popup.js` - extension UI and state flow
- `src/lib/lit.js` - Lit PKP, encryption, auth-context, and Lit Action integration
- `src/lib/smart-wallets.js` - smart-wallet creation, discovery, and Lit-gated execution
- `src/lib/csv.js` - CSV parsing and inference input mapping
- `contracts/src/Wallet.sol` - upgraded 2-of-2 execution wallet
- `contracts/src/WalletFactory.sol` - deterministic factory deployment

## Local Setup

1. Install dependencies:

```bash
npm install --legacy-peer-deps
```

2. Build the extension:

```bash
npm run build
```

3. Build and test the contracts:

```bash
npm run contracts:build
npm run contracts:test
```

4. Load the extension:

- Open Chrome or Chromium
- Go to `chrome://extensions`
- Enable Developer Mode
- Load either the repo root or the `dist` directory as an unpacked extension

## Deploying The Upgraded Smart Wallet Factory

Deploy the upgraded factory with:

```bash
PRIVATE_KEY=... npm run contracts:deploy:sepolia
```

After deployment, update `src/smart-wallet-deployment.js` with:

- the new factory address
- the deployment block number

This is required for Lit-backed wallet creation and on-chain discovery of the upgraded wallet format.

## Lit And Impulse Configuration

To use the Lit-backed wallet flow, the user needs:

- a funded base wallet in the extension
- an Impulse AI deployment ID
- an Impulse AI API key

At wallet creation time, Ember uses those values to generate the Lit-backed second signer and encrypted inference configuration. At sign time, the user uploads a one-row CSV of biometric features, and the Lit Action uses the Impulse endpoint to decide whether the second signature should exist.

## Demo Expectations

For a full challenge submission, the project should be accompanied by:

- a working prototype or demo
- a public GitHub repository
- this documentation
- a 2-5 minute demo video showing wallet creation, CSV upload, inference gating, and transaction allow/deny behavior

## Sponsor Technologies Used

- Lit Protocol V1 (Naga)
- Lit PKPs
- Lit Actions
- Lit encryption and programmable signing
- Impulse AI inference API
- Ethereum Sepolia
- Browser extension wallet UX

## Conceptual Framing

Ember is ultimately a cognitive sovereignty wallet: a wallet that does not just ask, “do you have the key?” but also asks, “are you safe enough to use it right now?” It combines decentralized key management, AI inference, and live biometric context into a programmable safety rail for self-custody, exploring how neurotech can be applied to digital rights, anti-coercion infrastructure, and human-centered crypto security.
