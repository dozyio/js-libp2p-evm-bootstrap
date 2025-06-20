/**
 * @packageDocumentation
 *
 * The configured evm smart contract will be used to lookup bootstrap peers.
 * The bootstrap peers will be discovered after the configured timeout.
 * This will ensure there are some peers in the peer store for the node to use to discover other peers.
 *
 * They will be tagged with a tag with the name `'evmbootstrap'` tag, the value `50` and it will expire after two minutes which means the nodes connections may be closed if the maximum number of connections is reached.
 *
 * Clients that need constant connections to bootstrap nodes (e.g. browsers) can set the TTL to `Infinity`.
 * 
 * @example Configuring the evm bootstrap module
 *
 *
 * ```TypeScript
 * import { createLibp2p } from 'libp2p'
 * import { bootstrap } from '@dozyio/libp2p-evm-bootstrap'
 * import { BrowserProvider } from 'ethers'
 *
 * const provider = new BrowserProvider(window.ethereum)
 *
 * const libp2p = await createLibp2p({
 *   peerDiscovery: [
 *     bootstrap({
 *       contractAddress: '0x1234567890123456789012345678901234567890',
 *       contractIndex: '0x1234567890123456789012345678901234567890', // the address of the wallet that manages the bootstrappers
 *       chainId: 1n,
 *       ethereum: provider
 *     })
 *   ]
 * })
 *
 * libp2p.addEventListener('peer:discovery', (evt) => {
 *   console.log('found peer: ', evt.detail.toString())
 * })
 * ```
 */

import { peerDiscoverySymbol, serviceCapabilities } from '@libp2p/interface'
import { peerIdFromString } from '@libp2p/peer-id'
import { TypedEventEmitter } from 'main-event'
import type { Provider } from 'ethers'
import type { ComponentLogger, Logger, PeerDiscovery, PeerDiscoveryEvents, PeerInfo, PeerRouting, PeerStore, Startable } from '@libp2p/interface'
import type { ConnectionManager } from '@libp2p/interface-internal'
import { Contract } from 'ethers'
import { BrowserProvider } from 'ethers'

const DEFAULT_BOOTSTRAP_TAG_NAME = 'evmbootstrap'
const DEFAULT_BOOTSTRAP_TAG_VALUE = 50
const DEFAULT_BOOTSTRAP_DISCOVERY_TIMEOUT = 1000
const CONTRACT_ABI = [
  'function MAX_PEERS() view returns (uint8)',
  'function ID_LENGTH() view returns (uint16)',
  'function getPeerCount(address) view returns (uint8)',
  'function getAllPeerIds(address) view returns (string[])',
  'function getPeerId(address, uint8) view returns (string)',
  'function addPeerId(string calldata peerId)',
  'function setPeerId(uint8 slot, string calldata peerId)',
  'function removePeerId(uint8 slot)'
];

export interface BootstrapInit {
  /**
   * The smart contract address 
   */
  contractAddress: string

  /**
   * The contract index - e.g. the ethereum address that created the bootstrappers
   */
  contractIndex: string

  /**
   * Chain ID where the contract is deployed
   */
  chainId: bigint

  /**
   * Ethereum provider (e.g., window.ethereum from MetaMask)
   */
  ethereum: Provider

  /**
   * How long to wait before discovering bootstrap nodes
   */
  timeout?: number

  /**
   * Tag a bootstrap peer with this name before "discovering" it
   *
   * @default 'evmbootstrap'
   */
  tagName?: string

  /**
   * The bootstrap peer tag will have this value
   *
   * @default 50
   */
  tagValue?: number

  /**
   * Cause the bootstrap peer tag to be removed after this number of ms
   */
  tagTTL?: number
}

export interface BootstrapComponents {
  peerStore: PeerStore
  logger: ComponentLogger
  connectionManager: ConnectionManager
  peerRouting: PeerRouting
}

/**
 * Emits 'peer' events on a regular interval for each peer in the provided list.
 */
class EVMBootstrap extends TypedEventEmitter<PeerDiscoveryEvents> implements PeerDiscovery, Startable {
  static tag = 'evmbootstrap'

  private readonly log: Logger
  private timer?: ReturnType<typeof setTimeout>
  private readonly list: PeerInfo[]
  private readonly timeout: number
  private readonly components: BootstrapComponents
  private readonly _init: BootstrapInit

  constructor(components: BootstrapComponents, options: BootstrapInit) {
    if (options.contractAddress == null) {
      throw new Error('EVMBootstrap requires a contract address')
    }
    if (options.contractIndex == null) {
      throw new Error('EVMBootstrap requires a contract index')
    }
    if (options.chainId == null) {
      throw new Error('EVMBootstrap requires a chain id')
    }
    if (options.ethereum == null) {
      throw new Error('EVMBootstrap requires an ethereum provider')
    }

    super()

    this.components = components
    this.log = components.logger.forComponent('libp2p:bootstrap')
    this.timeout = options.timeout ?? DEFAULT_BOOTSTRAP_DISCOVERY_TIMEOUT
    this.list = []

    this._init = {
      ...options,
      ethereum: toEthersProvider(options.ethereum)
    }
  }

  readonly [peerDiscoverySymbol] = this

  readonly [Symbol.toStringTag] = '@dozyio/evmbootstrap'

  readonly [serviceCapabilities]: string[] = [
    '@libp2p/peer-discovery'
  ]

  isStarted(): boolean {
    return Boolean(this.timer)
  }

  /**
   * Start emitting events
   */
  start(): void {
    if (this.isStarted()) {
      return
    }

    this.log('Starting evm bootstrap node discovery, discovering peers after %s ms', this.timeout)
    this.timer = setTimeout(() => {
      void this._discoverBootstrapPeers()
        .catch(err => {
          this.log.error(err)
        })
    }, this.timeout)
  }

  /**
   * Emit each address in the list as a PeerInfo
   */
  async _discoverBootstrapPeers(): Promise<void> {
    if (this.timer == null) {
      return
    }

    const network = await this._init.ethereum.getNetwork();
    if (network.chainId !== this._init.chainId) {
      this.log.error(
        `Ethereum provider is connected to chainId ${network.chainId}, but expected ${this._init.chainId}. Please switch networks in your wallet.`
      );
      throw new Error(`Wrong network: expected chainId ${this._init.chainId}, got ${network.chainId}`);
    }

    try {
      const contract = new Contract(this._init.contractAddress, CONTRACT_ABI, this._init.ethereum)
      const peerIds = await contract.getAllPeerIds(this._init.contractIndex)
      this.log('Found %d bootstrap peers ids', peerIds.length, peerIds)
      for (const peerIdStr of peerIds) {
        try {
          const peerId = peerIdFromString(peerIdStr)
          const peerInfo = await this.components.peerRouting.findPeer(peerId)
          this.list.push(peerInfo)
        } catch (err) {
          this.log.error('Could not lookup  multiaddrs for bootstrap peer', peerIdStr, err)
        }
      }

      for (const peerData of this.list) {
        await this.components.peerStore.merge(peerData.id, {
          tags: {
            [this._init.tagName ?? DEFAULT_BOOTSTRAP_TAG_NAME]: {
              value: this._init.tagValue ?? DEFAULT_BOOTSTRAP_TAG_VALUE,
              ttl: this._init.tagTTL
            }
          },
          multiaddrs: peerData.multiaddrs
        })

        // check we are still running
        if (this.timer == null) {
          return
        }

        this.safeDispatchEvent('peer', { detail: peerData })
        this.components.connectionManager.openConnection(peerData.id)
          .catch(err => {
            this.log.error('could not dial bootstrap peer %p', peerData.id, err)
          })
      }
    } catch (err) {
      this.log.error('Could not discover bootstrap peers', err)
    }
  }


  /**
   * Stop emitting events
   */
  stop(): void {
    if (this.timer != null) {
      clearTimeout(this.timer)
    }

    this.timer = undefined
  }
}

export function evmbootstrap(init: BootstrapInit): (components: BootstrapComponents) => PeerDiscovery {
  return (components: BootstrapComponents) => new EVMBootstrap(components, init)
}

function toEthersProvider(input: Provider | any): Provider {
  // If already an ethers Provider, return as is
  if (input && typeof input.getNetwork === 'function') {
    return input as Provider;
  }
  // If looks like an EIP-1193 provider, wrap it
  if (input && typeof window !== 'undefined' && input.request) {
    return new BrowserProvider(input);
  }
  throw new Error('Invalid provider: must be an ethers Provider or EIP-1193 provider');
}