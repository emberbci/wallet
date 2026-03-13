// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "../src/Wallet.sol";
import "../src/WalletFactory.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(
        uint256 privateKey,
        bytes32 digest
    ) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract Target {
    uint256 public number;
    uint256 public totalReceived;

    function setNumber(uint256 nextNumber) external payable {
        number = nextNumber;
        totalReceived += msg.value;
    }
}

contract WalletFactoryTest {
    Vm internal constant vm = Vm(
        address(uint160(uint256(keccak256("hevm cheat code"))))
    );

    WalletFactory internal walletFactory;
    Target internal target;

    address internal constant ENTRY_POINT =
        0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789;

    function setUp() public {
        walletFactory = new WalletFactory(ENTRY_POINT);
        target = new Target();
    }

    function testFactoryReturnsDeterministicAddress() public {
        address[] memory owners = _owners();
        uint256 salt = 101;

        address predicted = walletFactory.getAddress(owners, salt);
        Wallet created = walletFactory.createAccount(owners, salt);

        require(address(created) == predicted, "predicted address mismatch");
    }

    function testCreateAccountIsIdempotentForSameSalt() public {
        address[] memory owners = _owners();
        uint256 salt = 202;

        address first = address(walletFactory.createAccount(owners, salt));
        address second = address(walletFactory.createAccount(owners, salt));

        require(first == second, "createAccount should reuse deployed wallet");
    }

    function testWalletInitializationRejectsWrongOwnerCount() public {
        address[] memory owners = new address[](1);
        owners[0] = vm.addr(11);

        (bool success, ) = address(walletFactory).call(
            abi.encodeWithSelector(
                walletFactory.createAccount.selector,
                owners,
                77
            )
        );

        require(!success, "factory should reject non 2-of-2 owners");
    }

    function testExecuteRequiresBothCorrectSignaturesInOrder() public {
        uint256 signerOneKey = 11;
        uint256 signerTwoKey = 22;
        address[] memory owners = new address[](2);
        owners[0] = vm.addr(signerOneKey);
        owners[1] = vm.addr(signerTwoKey);

        Wallet wallet = walletFactory.createAccount(owners, 303);
        bytes memory data = abi.encodeWithSelector(Target.setNumber.selector, 42);
        bytes32 digest = wallet.getExecutionHash(address(target), 0, data, 0);

        bytes[] memory signatures = new bytes[](2);
        signatures[0] = _sign(signerOneKey, digest);
        signatures[1] = _sign(signerTwoKey, digest);

        wallet.execute(address(target), 0, data, 0, signatures);

        require(target.number() == 42, "target call should succeed");
        require(wallet.nonce() == 1, "nonce should increment");
    }

    function testExecuteRejectsWrongNonceOrSignatureOrder() public {
        uint256 signerOneKey = 11;
        uint256 signerTwoKey = 22;
        address[] memory owners = new address[](2);
        owners[0] = vm.addr(signerOneKey);
        owners[1] = vm.addr(signerTwoKey);

        Wallet wallet = walletFactory.createAccount(owners, 404);
        bytes memory data = abi.encodeWithSelector(Target.setNumber.selector, 7);
        bytes32 digest = wallet.getExecutionHash(address(target), 0, data, 0);

        bytes[] memory wrongOrder = new bytes[](2);
        wrongOrder[0] = _sign(signerTwoKey, digest);
        wrongOrder[1] = _sign(signerOneKey, digest);

        (bool wrongOrderSuccess, ) = address(wallet).call(
            abi.encodeWithSelector(
                wallet.execute.selector,
                address(target),
                0,
                data,
                0,
                wrongOrder
            )
        );
        require(!wrongOrderSuccess, "wrong signature order should revert");

        bytes[] memory correct = new bytes[](2);
        correct[0] = _sign(signerOneKey, digest);
        correct[1] = _sign(signerTwoKey, digest);
        wallet.execute(address(target), 0, data, 0, correct);

        bytes memory secondData = abi.encodeWithSelector(Target.setNumber.selector, 8);
        bytes32 staleDigest = wallet.getExecutionHash(address(target), 0, secondData, 0);
        bytes[] memory staleNonceSignatures = new bytes[](2);
        staleNonceSignatures[0] = _sign(signerOneKey, staleDigest);
        staleNonceSignatures[1] = _sign(signerTwoKey, staleDigest);

        (bool staleNonceSuccess, ) = address(wallet).call(
            abi.encodeWithSelector(
                wallet.execute.selector,
                address(target),
                0,
                secondData,
                0,
                staleNonceSignatures
            )
        );
        require(!staleNonceSuccess, "stale nonce should revert");
    }

    function testValidateSignaturesRejectsMissingOrDuplicateSigners() public {
        uint256 signerOneKey = 11;
        uint256 signerTwoKey = 22;
        address[] memory owners = new address[](2);
        owners[0] = vm.addr(signerOneKey);
        owners[1] = vm.addr(signerTwoKey);

        Wallet wallet = walletFactory.createAccount(owners, 505);
        bytes32 digest = keccak256("ember-wallet-smart-wallet");

        bytes[] memory singleSignature = new bytes[](1);
        singleSignature[0] = _sign(signerOneKey, digest);
        require(
            !wallet.validateSignatures(digest, singleSignature),
            "single signature should fail"
        );

        bytes[] memory duplicate = new bytes[](2);
        duplicate[0] = _sign(signerOneKey, digest);
        duplicate[1] = _sign(signerOneKey, digest);
        require(
            !wallet.validateSignatures(digest, duplicate),
            "duplicate signer should fail"
        );
    }

    function _owners() internal returns (address[] memory owners) {
        owners = new address[](2);
        owners[0] = vm.addr(11);
        owners[1] = vm.addr(22);
    }

    function _sign(
        uint256 privateKey,
        bytes32 digest
    ) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
