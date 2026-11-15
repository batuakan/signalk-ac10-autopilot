import { expect } from 'chai'
import http from 'node:http'
import { AddressInfo } from 'node:net'
import { EspHomeRemote } from '../src/esphome'

/** Minimal stand-in for the ESPHome web_server */
function fakeEsp() {
  const requests: string[] = []
  const streams: http.ServerResponse[] = []
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`.trim())
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('retry: 30000\r\nevent: ping\r\ndata: {}\r\n\r\n')
      streams.push(res)
    } else if (req.url?.startsWith('/button/') || req.url?.startsWith('/number/')) {
      res.writeHead(200).end()
    } else {
      res.writeHead(404).end()
    }
  })
  const send = (data: object) =>
    streams.forEach((s) => s.write(`event: state\ndata: ${JSON.stringify(data)}\n\n`))
  return { server, requests, streams, send }
}

const once = <T>(em: EspHomeRemote, ev: 'connected' | 'engaged' | 'pendingSteps' | 'disconnected') =>
  new Promise<T>((r) => em.once(ev, ((v: T) => r(v)) as never))

describe('EspHomeRemote', () => {
  let esp: ReturnType<typeof fakeEsp>
  let remote: EspHomeRemote

  beforeEach(async () => {
    esp = fakeEsp()
    await new Promise<void>((r) => esp.server.listen(0, '127.0.0.1', r))
    const port = (esp.server.address() as AddressInfo).port
    remote = new EspHomeRemote({ host: '127.0.0.1', port, username: 'u', password: 'p', staleTimeout: 1 })
  })
  afterEach(async () => {
    remote.stop()
    esp.streams.forEach((s) => s.end())
    esp.server.closeAllConnections()
    await new Promise((r) => esp.server.close(r))
  })

  it('tracks the Lamp state from SSE, both id formats', async () => {
    remote.start()
    await once(remote, 'connected')
    let p = once<boolean>(remote, 'engaged')
    esp.send({ id: 'binary_sensor-ap_engaged', value: true, state: 'ON' })
    expect(await p).to.equal(true)
    p = once<boolean>(remote, 'engaged')
    esp.send({ id: 'binary_sensor/ap_engaged', state: 'OFF' })
    expect(await p).to.equal(false)
    const s = once<number>(remote, 'pendingSteps')
    esp.send({ id: 'sensor-ap_pending_steps', value: -4, state: '-4' })
    expect(await s).to.equal(-4)
  })

  it('sends presses and steps with basic auth', async () => {
    remote.start()
    await once(remote, 'connected')
    await remote.press('ap_engage')
    await remote.steps(-12)
    const auth = 'Basic ' + Buffer.from('u:p').toString('base64')
    expect(esp.requests).to.include(`POST /button/ap_engage/press ${auth}`)
    expect(esp.requests).to.include(`POST /number/ap_steps/set?value=-12 ${auth}`)
  })

  it('refuses commands while disconnected', async () => {
    let err: Error | undefined
    await remote.press('ap_engage').catch((e) => (err = e))
    expect(err?.message).to.match(/not connected/)
  })

  it('drops to unknown state and reconnects when the stream goes stale', async () => {
    remote.start()
    await once(remote, 'connected')
    esp.send({ id: 'binary_sensor-ap_engaged', value: true })
    await once(remote, 'engaged')
    const lost = once<boolean | undefined>(remote, 'engaged')
    // no traffic for > staleTimeout (1 s)
    expect(await lost).to.equal(undefined)
    expect(remote.connected).to.equal(false)
    await once(remote, 'connected')
    expect(esp.requests.filter((r) => r.startsWith('GET /events')).length).to.be.greaterThan(1)
  })
})

describe('EspHomeRemote digest auth', () => {
  it('answers a Digest challenge (qop=auth) on events and commands', async () => {
    const { createHash } = await import('node:crypto')
    const md5 = (s: string) => createHash('md5').update(s).digest('hex')
    const realm = 'asyncesp'
    const nonce = 'abc123'
    const ok: string[] = []
    const server = http.createServer((req, res) => {
      const auth = req.headers.authorization ?? ''
      const f: Record<string, string> = {}
      for (const m of auth.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) f[m[1]] = m[2] ?? m[3]
      const expected = md5(
        `${md5(`u:${realm}:p`)}:${nonce}:${f.nc}:${f.cnonce}:auth:${md5(`${req.method}:${f.uri}`)}`
      )
      if (!auth.startsWith('Digest ') || f.response !== expected || f.uri !== req.url) {
        res.writeHead(401, {
          'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}", opaque="o"`
        })
        return res.end()
      }
      ok.push(`${req.method} ${req.url}`)
      if (req.url === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('event: ping\ndata: {}\n\n')
      } else res.writeHead(200).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const remote = new EspHomeRemote({ host: '127.0.0.1', port, username: 'u', password: 'p' })
    try {
      remote.start()
      await once(remote, 'connected')
      await remote.press('ap_standby')
      expect(ok).to.deep.equal(['GET /events', 'POST /button/ap_standby/press'])
    } finally {
      remote.stop()
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    }
  })
})
