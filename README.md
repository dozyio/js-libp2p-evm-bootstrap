# js-libp2p-evm-bootstrap

Load libp2p bootstrapper peer IDs from an EVM blockchain

```TypeScript
import { createLibp2p } from 'libp2p'
import { evmbootstrap } from '@dozyio/libp2p-evm-bootstrap'
import { BrowserProvider } from 'ethers'
 import { createDelegatedRoutingV1HttpApiClient } from '@helia/delegated-routing-v1-http-api-client'

const provider = new BrowserProvider(window.ethereum)
const client = createDelegatedRoutingV1HttpApiClient('https://delegated-ipfs.dev')

const libp2p = await createLibp2p({
  peerDiscovery: [
    evmbootstrap({
      contractAddress: '0xfef23139179004d7d636a1e66316e42085640262', // address of the contract
      contractIndex: '0x3ad5a918f803de563a7c5327d6cc1fb083cce9c6', // the address of the wallet that manages the bootstrappers
      chainId: BigInt(11155111),
      ethereum: provider
    })
  ],
  services: {
    delegatedRouting: () => client
  }
})

libp2p.addEventListener('peer:discovery', (evt) => {
  console.log('found peer: ', evt.detail.toString())
})
```

## Deployed contract details

Uses IPFS bootstrappers

Test contract address on Sepolia: 0xfef23139179004d7d636a1e66316e42085640262

Test contract index: 0x3ad5a918f803de563a7c5327d6cc1fb083cce9c6

Test chain id: BigInt(11155111)

## Related Repos:

* [Demo](https://dozy.io/evm-bootstrap-demo/)
* [Demo frontend source code](https://github.com/dozyio/evm-bootstrap-demo)
* [DApp demo](https://dozy.io/libp2p-evm-bootstrap-dapp/)
* [DApp source code](https://github.com/dozyio/libp2p-evm-bootstrap-dapp)
* [EVM Contract](https://github.com/dozyio/evm-bootstrap-contract)
