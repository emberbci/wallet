// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Wallet {
    bytes32 internal constant EXECUTE_TYPEHASH =
        keccak256(
            "EmberWalletExecute(address wallet,uint256 chainId,address target,uint256 value,bytes32 dataHash,uint256 nonce)"
        );

    address public immutable walletFactory;
    address public immutable entryPoint;

    address[] private _owners;
    bool public initialized;
    uint256 public nonce;

    event WalletInitialized(
        address indexed entryPointAddress,
        address indexed owner1,
        address indexed owner2
    );
    event WalletExecuted(
        uint256 indexed nonce,
        address indexed target,
        uint256 value,
        bytes data
    );

    modifier onlyWalletFactory() {
        require(msg.sender == walletFactory, "only wallet factory");
        _;
    }

    constructor(address entryPointAddress, address factoryAddress) {
        entryPoint = entryPointAddress;
        walletFactory = factoryAddress;
    }

    function initialize(address[] memory initialOwners) external onlyWalletFactory {
        require(!initialized, "wallet already initialized");
        require(initialOwners.length == 2, "need exactly 2 owners");
        require(
            initialOwners[0] != address(0) && initialOwners[1] != address(0),
            "owner cannot be zero"
        );
        require(
            initialOwners[0] != initialOwners[1],
            "owners must be different"
        );

        initialized = true;
        _owners = initialOwners;

        emit WalletInitialized(entryPoint, initialOwners[0], initialOwners[1]);
    }

    function owners() external view returns (address[] memory) {
        return _owners;
    }

    function isSigner(address account) external view returns (bool) {
        if (_owners.length != 2) return false;

        return _owners[0] == account || _owners[1] == account;
    }

    function getExecutionHash(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 executionNonce
    ) external view returns (bytes32) {
        return _getExecutionHash(target, value, data, executionNonce);
    }

    function execute(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 executionNonce,
        bytes[] calldata signatures
    ) external payable {
        require(initialized, "wallet not initialized");
        require(executionNonce == nonce, "invalid nonce");
        require(_validateSignatures(target, value, data, executionNonce, signatures), "invalid signatures");

        nonce = executionNonce + 1;

        (bool success, bytes memory result) = target.call{value: value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }

        emit WalletExecuted(executionNonce, target, value, data);
    }

    function validateSignatures(
        bytes32 digest,
        bytes[] calldata signatures
    ) external view returns (bool) {
        return _validateSignaturesForDigest(digest, signatures);
    }

    function _validateSignatures(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 executionNonce,
        bytes[] calldata signatures
    ) internal view returns (bool) {
        bytes32 digest = _getExecutionHash(target, value, data, executionNonce);
        return _validateSignaturesForDigest(digest, signatures);
    }

    function _validateSignaturesForDigest(
        bytes32 digest,
        bytes[] calldata signatures
    ) internal view returns (bool) {
        if (_owners.length != 2 || signatures.length != 2) {
            return false;
        }

        return
            _recover(digest, signatures[0]) == _owners[0] &&
            _recover(digest, signatures[1]) == _owners[1];
    }

    function _getExecutionHash(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 executionNonce
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    EXECUTE_TYPEHASH,
                    address(this),
                    block.chainid,
                    target,
                    value,
                    keccak256(data),
                    executionNonce
                )
            );
    }

    function _recover(
        bytes32 digest,
        bytes memory signature
    ) internal pure returns (address signer) {
        if (signature.length != 65) {
            return address(0);
        }

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }

        if (v < 27) v += 27;
        if (v != 27 && v != 28) {
            return address(0);
        }

        signer = ecrecover(digest, v, r, s);
    }

    receive() external payable {}
}
