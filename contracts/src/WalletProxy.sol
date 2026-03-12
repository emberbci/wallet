// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract WalletProxy {
    address internal immutable implementation;

    constructor(address implementationAddress, bytes memory initData) payable {
        implementation = implementationAddress;

        if (initData.length > 0) {
            (bool success, bytes memory result) = implementationAddress.delegatecall(
                initData
            );
            if (!success) {
                assembly {
                    revert(add(result, 32), mload(result))
                }
            }
        }
    }

    fallback() external payable {
        _delegate();
    }

    receive() external payable {
        _delegate();
    }

    function _delegate() internal {
        address target = implementation;

        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(
                gas(),
                target,
                0,
                calldatasize(),
                0,
                0
            )
            returndatacopy(0, 0, returndatasize())

            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }
}
