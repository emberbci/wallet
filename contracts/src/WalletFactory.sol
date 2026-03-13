// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "./Wallet.sol";
import "./WalletProxy.sol";

contract WalletFactory {
    Wallet public immutable walletImplementation;
    address public immutable entryPoint;

    event WalletCreated(
        address indexed wallet,
        address indexed owner1,
        address indexed owner2,
        uint256 salt
    );

    constructor(address entryPointAddress) {
        entryPoint = entryPointAddress;
        walletImplementation = new Wallet(entryPointAddress, address(this));
    }

    function createAccount(
        address[] memory owners,
        uint256 salt
    ) external returns (Wallet wallet) {
        _validateOwners(owners);

        address walletAddress = getAddress(owners, salt);
        if (walletAddress.code.length > 0) {
            return Wallet(payable(walletAddress));
        }

        bytes memory walletInit = abi.encodeCall(Wallet.initialize, (owners));
        WalletProxy proxy = new WalletProxy{salt: bytes32(salt)}(
            address(walletImplementation),
            walletInit
        );
        wallet = Wallet(payable(address(proxy)));

        emit WalletCreated(address(proxy), owners[0], owners[1], salt);
    }

    function getAddress(
        address[] memory owners,
        uint256 salt
    ) public view returns (address) {
        _validateOwners(owners);

        bytes memory walletInit = abi.encodeCall(Wallet.initialize, (owners));
        bytes memory proxyConstructor = abi.encode(
            address(walletImplementation),
            walletInit
        );
        bytes memory bytecode = abi.encodePacked(
            type(WalletProxy).creationCode,
            proxyConstructor
        );
        bytes32 bytecodeHash = keccak256(bytecode);

        return
            address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(
                                bytes1(0xff),
                                address(this),
                                bytes32(salt),
                                bytecodeHash
                            )
                        )
                    )
                )
            );
    }

    function _validateOwners(address[] memory owners) internal pure {
        require(owners.length == 2, "need exactly 2 owners");
        require(
            owners[0] != address(0) && owners[1] != address(0),
            "owner cannot be zero"
        );
        require(owners[0] != owners[1], "owners must be different");
    }
}
