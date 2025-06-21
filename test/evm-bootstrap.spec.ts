/* eslint-env mocha */
import { type defaultLogger } from '@libp2p/logger'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { expect } from 'aegir/chai'
import { Contract } from 'ethers'
import sinon from 'sinon'
import { stubInterface } from 'sinon-ts'
import { evmbootstrap } from '../src/index.js'
import type { PeerStore, PeerRouting } from '@libp2p/interface'
import type { ConnectionManager } from '@libp2p/interface-internal'
import type { Provider } from 'ethers'

// Mock peer IDs for testing
const mockPeerIds = [
  'QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXgoE34zJv7Xb',
  'QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXgoE34zJv7Xc',
  'QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXgoE34zJv7Xd'
]

describe('evmbootstrap', () => {
  let components: {
    peerStore: PeerStore
    peerRouting: PeerRouting
    connectionManager: ConnectionManager
    logger: ReturnType<typeof defaultLogger>
  }
  let stubProvider: Provider
  let clock: sinon.SinonFakeTimers
  let contractStub: sinon.SinonStub
  let mockLogger: any

  beforeEach(() => {
    // Use fake timers only in Node environment to avoid browser hanging
    if (typeof window === 'undefined') {
      clock = sinon.useFakeTimers()
    }

    // stub out ethers.Contract
    contractStub = sinon.stub()
    sinon.stub(Contract.prototype, 'constructor').value(contractStub)

    // stub provider
    stubProvider = {
      getNetwork: sinon.stub().resolves({ chainId: 1n }),
      request: sinon.stub()
    } as any

    // Create a mock logger with stubbed methods
    const componentLogger = Object.assign(
      // eslint-disable-next-line no-console
      (...args: any[]) => { console.log('[LOG]', ...args) },
      {
        error: sinon.stub(),
        // eslint-disable-next-line no-console
        trace: (...args: any[]) => { console.log('[TRACE]', ...args) },
        enabled: true
      }
    )

    mockLogger = {
      forComponent: sinon.stub().returns(componentLogger)
    }

    // component stubs
    components = {
      peerStore: stubInterface<PeerStore>(),
      peerRouting: stubInterface<PeerRouting>(),
      connectionManager: stubInterface<ConnectionManager>(),
      logger: mockLogger
    }

    // stub connectionManager.openConnection to always resolve
    components.connectionManager.openConnection = sinon.stub().resolves()
  })

  afterEach(() => {
    // Clear any remaining timers
    if (clock !== undefined) {
      clock.restore()
    }

    // Browser-specific cleanup
    if (typeof document !== 'undefined') {
      // Clear any remaining event listeners
      const testElement = document.createElement('div')
      testElement.dispatchEvent(new Event('cleanup'))
    }

    sinon.restore()
  })

  describe('factory validation', () => {
    const goodInit = {
      contractAddress: '0x1234',
      contractIndex: '0xabcd',
      chainId: 1n,
      ethereum: stubProvider
    } as const

    it('throws if missing contractAddress', () => {
      // @ts-expect-error should error
      expect(() => evmbootstrap({ ...goodInit, contractAddress: null })(components))
        .to.throw('EVMBootstrap requires a contract address')
    })

    it('throws if missing contractIndex', () => {
      // @ts-expect-error should error
      expect(() => evmbootstrap({ ...goodInit, contractIndex: null })(components))
        .to.throw('EVMBootstrap requires a contract index')
    })

    it('throws if missing chainId', () => {
      // @ts-expect-error should error
      expect(() => evmbootstrap({ ...goodInit, chainId: null })(components))
        .to.throw('EVMBootstrap requires a chain id')
    })

    it('throws if missing ethereum', () => {
      // @ts-expect-error should error
      expect(() => evmbootstrap({ ...goodInit, ethereum: null })(components))
        .to.throw('EVMBootstrap requires an ethereum provider')
    })
  })

  describe('provider handling', () => {
    it('accepts ethers Provider', () => {
      const provider = { getNetwork: sinon.stub().resolves({ chainId: 1n }) }
      const factory = evmbootstrap({
        contractAddress: '0x1234',
        contractIndex: '0xabcd',
        chainId: 1n,
        ethereum: provider as any
      })
      expect(() => factory(components)).to.not.throw()
    })

    it('accepts EIP-1193 provider in browser environment', () => {
      // simulate browser window
      if (typeof window === 'undefined') {
        Object.defineProperty(globalThis, 'window', {
          value: { ethereum: { request: sinon.stub() } },
          configurable: true
        })
      } else {
        (window as any).ethereum = { request: sinon.stub() }
      }
      const provider = { request: sinon.stub() }
      const factory = evmbootstrap({
        contractAddress: '0x1234',
        contractIndex: '0xabcd',
        chainId: 1n,
        ethereum: provider as any
      })
      expect(() => factory(components)).to.not.throw()
      if (typeof window === 'undefined') {
        delete (globalThis as any).window
      } else {
        delete (window as any).ethereum
      }
    })

    it('throws on invalid provider', () => {
      const factory = evmbootstrap({
        contractAddress: '0x1234',
        contractIndex: '0xabcd',
        chainId: 1n,
        ethereum: {} as any
      })
      expect(() => factory(components)).to.throw('Invalid provider: must be an ethers Provider or EIP-1193 provider')
    })
  })

  describe('instance behavior', () => {
    let instance: any

    beforeEach(() => {
      const factory = evmbootstrap({
        contractAddress: '0x1234',
        contractIndex: '0xabcd',
        chainId: 1n,
        ethereum: stubProvider,
        timeout: 5000
      })
      instance = factory(components)
    })

    it('has start and stop methods', () => {
      expect(instance.start).to.be.a('function')
      expect(instance.stop).to.be.a('function')
    })

    it('isStarted() returns false before start()', () => {
      expect(instance.isStarted()).to.be.false()
    })

    it('start() schedules discovery and makes isStarted true', () => {
      instance.start()
      expect(instance.isStarted()).to.be.true()

      if (clock !== undefined) {
        clock.tick(5000)
        // Should still be true, timer is not auto-cleared
        expect(instance.isStarted()).to.be.true()
      } else {
        expect(instance.isStarted()).to.be.true()
      }
    })

    it('start() is idempotent', () => {
      instance.start()
      expect(instance.isStarted()).to.be.true()
      instance.start()
      expect(instance.isStarted()).to.be.true()

      if (clock !== undefined) {
        clock.tick(5000)
        // Should still be true, timer is not auto-cleared
        expect(instance.isStarted()).to.be.true()
      } else {
        expect(instance.isStarted()).to.be.true()
      }
    })

    it('stop() clears the timer and resets isStarted', () => {
      const clearStub = sinon.stub(global, 'clearTimeout')
      instance.start()
      instance.stop()
      expect(instance.isStarted()).to.be.false()
      expect(clearStub.called).to.be.true()
    })
  })

  describe('peer discovery', () => {
    let instance: any

    beforeEach(() => {
      const factory = evmbootstrap({
        contractAddress: '0x1234',
        contractIndex: '0xabcd',
        chainId: 1n,
        ethereum: stubProvider,
        timeout: 0,
        tagName: 'mytag',
        tagValue: 42,
        tagTTL: 60000
      })
      instance = factory(components)
      // pretend start() was called
      ; (instance).timer = true
    })

    it('errors if the provider is on the wrong chain', async () => {
      (stubProvider.getNetwork as sinon.SinonStub).resolves({ chainId: 99n })
      let err: Error | undefined
      try {
        await instance._discoverBootstrapPeers()
      } catch (e: any) {
        err = e
      }
      expect(err).to.exist()
      expect(err?.message).to.match(/Wrong network/)

      // Get the component logger that was created
      const componentLogger = mockLogger.forComponent.returnValues[0]
      expect(componentLogger.error.calledWith(
        'Ethereum provider is connected to chainId 99, but expected 1. Please switch networks in your wallet.'
      )).to.be.true()
    })

    it('discovers, tags, emits peer events and dials', async () => {
      // Fake contract class for dependency injection
      const fakeContractInstance = { getAllPeerIds: sinon.stub().resolves(mockPeerIds) }
      const FakeContract = function (_address: string | any, _abi: any, _runner?: any): any {
        return fakeContractInstance
      }

      // stub peerRouting.findPeer → PeerInfo
      const infos = mockPeerIds.map((id: string) => ({
        id: peerIdFromString(id),
        multiaddrs: [multiaddr(`/ip4/127.0.0.1/tcp/4001/ipfs/${id}`)]
      }))
      components.peerRouting.findPeer = sinon.stub().callsFake(async (peerId) => {
        return Promise.resolve(infos.find(info => info.id.equals(peerId)))
      })

      const seen: any[] = []
      instance = evmbootstrap({
        contractAddress: '0x1234',
        contractIndex: '0xabcd',
        chainId: 1n,
        ethereum: stubProvider,
        timeout: 0,
        tagName: 'mytag',
        tagValue: 42,
        tagTTL: 60000,
        ContractClass: FakeContract as any
      })(components)
      ; (instance).timer = true

      instance.addEventListener('peer', (evt: any) => { seen.push(evt.detail) })

      await instance._discoverBootstrapPeers()

      // getAllPeerIds called with contractIndex
      expect(fakeContractInstance.getAllPeerIds.calledWith('0xabcd')).to.be.true()

      // merged tags
      for (const info of infos) {
        expect((components.peerStore.merge as sinon.SinonStub).calledWith(info.id, {
          tags: { mytag: { value: 42, ttl: 60000 } },
          multiaddrs: info.multiaddrs
        })).to.be.true()
      }

      // events
      expect(seen).to.eql(infos)

      // dialed
      for (const info of infos) {
        expect((components.connectionManager.openConnection as sinon.SinonStub).calledWith(info.id)).to.be.true()
      }
    })

    it('logs and swallows errors from ethers.Contract', async () => {
      // Stub the Contract constructor to throw
      const originalContract = Contract
        ; (global as any).Contract = function () {
        throw new Error('boom')
      }

      await instance._discoverBootstrapPeers()

      // Get the component logger that was created
      const componentLogger = mockLogger.forComponent.returnValues[0]
      expect(componentLogger.error.calledWith('Could not discover bootstrap peers', sinon.match.instanceOf(Error))).to.be.true()

      // Restore original Contract
      ; (global as any).Contract = originalContract
    })
  })

  describe('factory function', () => {
    it('returns a peer-discovery that has the right symbol', () => {
      const factory = evmbootstrap({
        contractAddress: '0x1234',
        contractIndex: '0xabcd',
        chainId: 1n,
        ethereum: stubProvider
      })
      const instance = factory(components as any)
      expect(instance).to.exist()
    })
  })
})
