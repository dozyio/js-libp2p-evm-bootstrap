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
 * import { evmbootstrap } from '@dozyio/libp2p-evm-bootstrap'
 * import { BrowserProvider } from 'ethers'
 *  import { createDelegatedRoutingV1HttpApiClient } from '@helia/delegated-routing-v1-http-api-client'
 *
 * const provider = new BrowserProvider(window.ethereum)
 * const client = createDelegatedRoutingV1HttpApiClient('https://delegated-ipfs.dev')
 *
 * const libp2p = await createLibp2p({
 *   peerDiscovery: [
 *     evmbootstrap({
 *       contractAddress: '0x1234567890123456789012345678901234567890',
 *       contractIndex: '0x1234567890123456789012345678901234567890', // the address of the wallet that manages the bootstrappers
 *       chainId: 1n,
 *       ethereum: provider
 *     })
 *   ],
 *   services: {
 *     delegatedRouting: () => client
 *   }
 * })
 *
 * libp2p.addEventListener('peer:discovery', (evt) => {
 *   console.log('found peer: ', evt.detail.toString())
 * })
 * ```
 *
 * Test contract address on Sepolia: 0xfef23139179004d7d636a1e66316e42085640262
 * Test contract index: 0x3ad5a918f803de563a7c5327d6cc1fb083cce9c6
 * Test chain id: BigInt(11155111)
 */

import { peerDiscoverySymbol, serviceCapabilities } from '@libp2p/interface'
import { peerIdFromString } from '@libp2p/peer-id'
import { Contract, BrowserProvider } from 'ethers'
import { TypedEventEmitter } from 'main-event'
import type { ComponentLogger, Logger, PeerDiscovery, PeerDiscoveryEvents, PeerInfo, PeerRouting, PeerStore, Startable } from '@libp2p/interface'
import type { ConnectionManager } from '@libp2p/interface-internal'
import type { Provider } from 'ethers'

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
]

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

  /**
   * Optionally inject a Contract class for testing
   */
  ContractClass?: typeof Contract
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
  private readonly ContractClass: typeof Contract

  constructor (components: BootstrapComponents, options: BootstrapInit) {
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
    this.log = components.logger.forComponent('libp2p:evmbootstrap')
    this.timeout = options.timeout ?? DEFAULT_BOOTSTRAP_DISCOVERY_TIMEOUT
    this.list = []
    this.ContractClass = options.ContractClass ?? Contract

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

  isStarted (): boolean {
    return Boolean(this.timer)
  }

  /**
   * Start emitting events
   */
  start (): void {
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
  async _discoverBootstrapPeers (): Promise<void> {
    this.log.trace('_discoverBootstrapPeers called')
    if (this.timer == null) {
      this.log.trace('timer is null, returning early')
      return
    }

    this.log.trace('Getting network from ethereum provider')
    const network = await this._init.ethereum.getNetwork()
    if (network.chainId !== this._init.chainId) {
      this.log.error(
        `Ethereum provider is connected to chainId ${network.chainId}, but expected ${this._init.chainId}. Please switch networks in your wallet.`
      )
      throw new Error(`Wrong network: expected chainId ${this._init.chainId}, got ${network.chainId}`)
    }

    try {
      this.log.trace('Creating contract instance')
      const contract = new this.ContractClass(this._init.contractAddress, CONTRACT_ABI, this._init.ethereum)
      this.log.trace('Calling getAllPeerIds')
      const peerIds = await contract.getAllPeerIds(this._init.contractIndex)
      this.log('Found %d bootstrap peers ids', peerIds.length, peerIds)
      this.log.trace('Processing peer IDs:', peerIds)
      for (const peerIdStr of peerIds) {
        try {
          this.log.trace('Processing peer ID:', peerIdStr)
          const peerId = peerIdFromString(peerIdStr)
          const peerInfo = await this.components.peerRouting.findPeer(peerId)
          this.list.push(peerInfo)
          this.log.trace('Added peer info to list:', peerInfo)
        } catch (err) {
          this.log.error('Could not lookup  multiaddrs for bootstrap peer', peerIdStr, err)
        }
      }

      this.log.trace('Processing peer list, count:', this.list.length)
      for (const peerData of this.list) {
        this.log.trace('Processing peer data:', peerData)
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
          this.log.trace('Timer is null, returning early')
          return
        }

        this.log.trace('Dispatching peer event')
        this.safeDispatchEvent('peer', { detail: peerData })
        this.log.trace('About to call openConnection for peer', peerData.id)
        this.components.connectionManager.openConnection(peerData.id)
          .then(() => {
            this.log.trace('Successfully called openConnection for peer', peerData.id)
          })
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
  stop (): void {
    if (this.timer != null) {
      clearTimeout(this.timer)
    }

    this.timer = undefined
  }
}

export function evmbootstrap (init: BootstrapInit): (components: BootstrapComponents) => PeerDiscovery {
  return (components: BootstrapComponents) => new EVMBootstrap(components, init)
}

export function toEthersProvider (input: Provider | any): Provider {
  // If already an ethers Provider, return as is
  if (input != null && typeof input.getNetwork === 'function') {
    return input as Provider
  }
  // If looks like an EIP-1193 provider, wrap it
  if (input != null && typeof window !== 'undefined' && typeof input.request === 'function') {
    return new BrowserProvider(input)
  }
  throw new Error('Invalid provider: must be an ethers Provider or EIP-1193 provider')
}
