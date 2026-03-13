// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "../src/WalletFactory.sol";

interface Vm {
    function envUint(string calldata name) external returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeployWalletFactoryScript {
    address internal constant DEFAULT_ENTRY_POINT =
        0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789;
    Vm internal constant vm = Vm(
        address(uint160(uint256(keccak256("hevm cheat code"))))
    );

    function run() external returns (WalletFactory walletFactory) {
        return run(DEFAULT_ENTRY_POINT);
    }

    function run(
        address entryPointAddress
    ) public returns (WalletFactory walletFactory) {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(privateKey);
        walletFactory = new WalletFactory(entryPointAddress);
        vm.stopBroadcast();
    }
}
