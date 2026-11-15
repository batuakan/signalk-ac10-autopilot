import { expect } from 'chai'
import { SignalKRemote } from '../src/signalk-remote'

type Reply = { state: string; statusCode: number; message?: string }
type Handler = (path: string, value: unknown) => Reply | null

/** Signal K server stand-in: a self bus, and putSelfPath that forwards to a fake device */
class FakeServer {
  subs: Record<string, ((v: { value: unknown; $source?: string }) => void)[]> = {}
  puts: { path: string; value: unknown }[] = []
  /** null = the device never answers (server would time out) */
  device: Handler = () => ({ state: 'COMPLETED', statusCode: 200 })

  debug() {}
  streambundle = {
    getSelfBus: (path: string) => ({
      onValue: (fn: (v: { value: unknown; $source?: string }) => void) => {
        ;(this.subs[path] ??= []).push(fn)
        return () => {
          this.subs[path] = this.subs[path].filter((f) => f !== fn)
        }
      }
    })
  }
  publish(path: string, value: unknown) {
    this.subs[path]?.forEach((fn) => fn({ value, $source: 'esphome.ac10-remote' }))
  }
  // Like signalk-server: resolves with PENDING, the device's reply arrives via the callback
  putSelfPath(path: string, value: unknown, cb: (r: Reply) => void) {
    this.puts.push({ path, value })
    const reply = this.device(path, value)
    if (reply) setTimeout(() => cb(reply), 5)
    return Promise.resolve({ state: 'PENDING', statusCode: 202 })
  }
}

const P = 'steering.autopilot.ac10'

describe('SignalKRemote', () => {
  let server: FakeServer
  let remote: SignalKRemote

  beforeEach(() => {
    server = new FakeServer()
    remote = new SignalKRemote(server, { staleTimeout: 0.3, putTimeout: 0.3 })
    remote.start()
  })
  afterEach(() => remote.stop())

  it('is offline until the device publishes its heartbeat', () => {
    expect(remote.connected).to.equal(false)
    expect(remote.engaged).to.equal(undefined)
    let connected = false
    remote.on('connected', () => (connected = true))
    server.publish(`${P}.engaged`, false)
    expect(connected).to.equal(true)
    expect(remote.engaged).to.equal(false)
  })

  it('ignores values that are not booleans', () => {
    server.publish(`${P}.engaged`, 1)
    expect(remote.connected).to.equal(false)
  })

  it('tracks engaged and queued steps', () => {
    const seen: unknown[] = []
    remote.on('engaged', (v) => seen.push(v))
    remote.on('pendingSteps', (v) => seen.push(v))
    server.publish(`${P}.engaged`, true)
    server.publish(`${P}.engaged`, true) // heartbeat, no change
    server.publish(`${P}.steps`, 7)
    expect(seen).to.deep.equal([true, 7])
    expect(remote.pendingSteps).to.equal(7)
  })

  it('goes offline when the heartbeat stops', async () => {
    server.publish(`${P}.engaged`, true)
    const reason = await new Promise((r) => remote.once('disconnected', r))
    expect(reason).to.match(/no heartbeat/)
    expect(remote.connected).to.equal(false)
    expect(remote.engaged).to.equal(undefined)
  })

  it('sends engage, standby and steps as PUTs', async () => {
    server.publish(`${P}.engaged`, false)
    await remote.engage()
    await remote.standby()
    await remote.steps(-9.6)
    expect(server.puts).to.deep.equal([
      { path: `${P}.engaged`, value: true },
      { path: `${P}.engaged`, value: false },
      { path: `${P}.steps`, value: -10 }
    ])
  })

  it("rejects with the device's message when it refuses", async () => {
    server.publish(`${P}.engaged`, false)
    server.device = () => ({ state: 'COMPLETED', statusCode: 400, message: 'Autopilot not engaged' })
    let err: Error | undefined
    await remote.steps(5).catch((e) => (err = e))
    expect(err?.message).to.equal('Autopilot not engaged')
  })

  it('rejects when no device handles the path (405 from the server)', async () => {
    server.publish(`${P}.engaged`, false)
    server.putSelfPath = (path: string, value: unknown) => {
      server.puts.push({ path, value })
      return Promise.resolve({ state: 'COMPLETED', statusCode: 405, message: `PUT not supported for ${path}` })
    }
    let err: Error | undefined
    await remote.engage().catch((e) => (err = e))
    expect(err?.message).to.match(/not supported/)
  })

  it('times out without a reply', async () => {
    server.publish(`${P}.engaged`, false)
    server.device = () => null
    let err: Error | undefined
    await remote.engage().catch((e) => (err = e))
    expect(err?.message).to.match(/No reply/)
  })

  it('refuses to send while offline', async () => {
    let err: Error | undefined
    await remote.engage().catch((e) => (err = e))
    expect(err?.message).to.match(/not connected/)
    expect(server.puts).to.deep.equal([])
  })

  it('uses a custom path prefix', async () => {
    remote.stop()
    remote = new SignalKRemote(server, { prefix: 'my.pilot' })
    remote.start()
    server.publish('my.pilot.engaged', true)
    await remote.steps(1)
    expect(server.puts).to.deep.equal([{ path: 'my.pilot.steps', value: 1 }])
  })
})
