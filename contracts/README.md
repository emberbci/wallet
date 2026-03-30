# Smart Wallet Contracts

Minimal deterministic 2-of-2 smart-wallet contracts for Ember Wallet.

## Commands

- `forge build --root contracts`
- `forge test --root contracts`
- `PRIVATE_KEY=... forge script contracts/script/DeployWalletFactory.s.sol:DeployWalletFactoryScript --rpc-url https://ethereum-sepolia-rpc.publicnode.com --broadcast`

## Notes

- The default EntryPoint is the canonical Sepolia ERC-4337 EntryPoint.
- The deployment private key must come from the environment, not from source files.
