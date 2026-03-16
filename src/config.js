import { sepolia } from "viem/chains";
import { SMART_WALLET_DEPLOYMENT } from "./smart-wallet-deployment.js";

// Primary + fallback Sepolia RPC endpoints (used in round-robin order on 429/5xx)
export const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
export const RPC_FALLBACKS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://rpc.sepolia.org",
  "https://sepolia.gateway.tenderly.co",
  "https://rpc2.sepolia.org",
];
export const EXPLORER_TX_BASE_URL = "https://sepolia.etherscan.io/tx/";
export const EXPLORER_ADDRESS_BASE_URL = "https://sepolia.etherscan.io/address/";
export const CHAIN = sepolia;

export const ENTRY_POINT_ADDRESS = SMART_WALLET_DEPLOYMENT.entryPointAddress;
export const SMART_WALLET_FACTORY_ADDRESS = SMART_WALLET_DEPLOYMENT.factoryAddress;
export const SMART_WALLET_FACTORY_DEPLOYMENT_BLOCK =
  SMART_WALLET_DEPLOYMENT.factoryDeploymentBlock;
export const LEGACY_SMART_WALLET_FACTORY_ADDRESS = SMART_WALLET_DEPLOYMENT.legacyFactoryAddress;
export const LEGACY_SMART_WALLET_FACTORY_DEPLOYMENT_BLOCK =
  SMART_WALLET_DEPLOYMENT.legacyFactoryDeploymentBlock;

export const LIT_NETWORK = "chipotleTestnet";
export const LIT_API_BASE_URL = "https://api.dev.litprotocol.com/core/v1";
export const LIT_DASHBOARD_URL = "https://dashboard.dev.litprotocol.com";
export const LIT_INFERENCE_ENDPOINT = "https://inference.impulselabs.ai";
export const INFERENCE_FEATURE_KEYS = [
  "mean_2_a",
  "mean_3_a",
  "fft_465_a",
  "fft_511_a",
  "fft_556_a",
];

export const NATIVE_ASSET = {
  id: "native",
  type: "native",
  symbol: "ETH",
  name: "Sepolia ETH",
  decimals: 18,
};

export const STORAGE_KEYS = {
  vault: "vault",
  vaultMeta: "vaultMeta",
  tokens: "tokens",
  smartWallets: "smartWallets",
  tokenDiscoveryCursors: "tokenDiscoveryCursors",
  recentRecipients: "recentRecipients",
  developerMode: "developerMode",
};

export const SESSION_KEY = "emberUnlockSession";
export const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const SMART_WALLET_FACTORY_ABI = [
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "createAccount",
    inputs: [
      { name: "owners", type: "address[]" },
      { name: "salt", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "getAddress",
    inputs: [
      { name: "owners", type: "address[]" },
      { name: "salt", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    anonymous: false,
    name: "WalletCreated",
    inputs: [
      { indexed: true, name: "wallet", type: "address" },
      { indexed: true, name: "owner1", type: "address" },
      { indexed: true, name: "owner2", type: "address" },
      { indexed: false, name: "salt", type: "uint256" },
    ],
  },
];

export const SMART_WALLET_ABI = [
  {
    type: "function",
    stateMutability: "view",
    name: "owners",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "isSigner",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "entryPoint",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "nonce",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "getExecutionHash",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "executionNonce", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "execute",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "executionNonce", type: "uint256" },
      { name: "signatures", type: "bytes[]" },
    ],
    outputs: [],
  },
];
