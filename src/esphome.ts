/*
 * ESPHome web_server client for the AC10 remote-port interface.
 *
 * The ESPHome device (see esphome/ac10-remote.yaml) owns all timing: every
 * output it drives is a momentary, firmware-timed pulse. This client only
 * asks for actions and listens for state, so a lost network connection can
 * never leave a button "held down".
 *
 * Transport: ESPHome's built-in web_server component.
 *   POST /button/<id>/press                 momentary actions
 *   POST /number/<id>/set?value=<n>         queue n course steps (+stbd/-port)
 *   GET  /events                            Server-Sent Events with entity state
 *
 * Entity names in the YAML are chosen equal to their object ids, so the URL is
 * the same whether the firmware addresses entities by object id or by name.
 */

import { EventEmitter } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'

export interface EspHomeOptions {
  host: string
  port?: number
  username?: string
  password?: string
  /** Seconds without any SSE traffic (ESPHome pings) before reconnecting */
  staleTimeout?: number
  /** Milliseconds to wait for a REST request */
  requestTimeout?: number
}

export const ENTITY = {
  engaged: 'ap_engaged',
  engage: 'ap_engage',
  standby: 'ap_standby',
  steps: 'ap_steps',
  cancelSteps: 'ap_cancel_steps',
  pendingSteps: 'ap_pending_steps'
} as const

type Fetch = typeof fetch

export interface EspHomeEvents {
  connected: []
  disconnected: [reason: string]
  engaged: [engaged: boolean | undefined]
  pendingSteps: [steps: number]
}

export class EspHomeRemote extends EventEmitter<EspHomeEvents> {
  readonly baseUrl: string
  private readonly user?: string
  private readonly pass: string
  private digest?: DigestChallenge
  private nonceCount = 0
  private readonly staleMs: number
  private readonly requestMs: number
  private abort?: AbortController
  private staleTimer?: NodeJS.Timeout
  private retryTimer?: NodeJS.Timeout
  private retryDelay = 1000
  private running = false

  connected = false
  engaged: boolean | undefined = undefined
  pendingSteps = 0

  constructor(
    opts: EspHomeOptions,
    private readonly fetchImpl: Fetch = fetch
  ) {
    super()
    this.baseUrl = `http://${opts.host}:${opts.port ?? 80}`
    this.user = opts.username || undefined
    this.pass = opts.password ?? ''
    this.staleMs = (opts.staleTimeout ?? 30) * 1000
    this.requestMs = opts.requestTimeout ?? 3000
  }

  start() {
    this.running = true
    this.connect()
  }

  stop() {
    this.running = false
    clearTimeout(this.retryTimer)
    clearTimeout(this.staleTimer)
    this.abort?.abort()
    this.setDisconnected('stopped')
  }

  get description() {
    return this.baseUrl
  }

  press(button: string): Promise<void> {
    return this.post(`/button/${button}/press`)
  }

  engage() {
    return this.press(ENTITY.engage)
  }

  standby() {
    return this.press(ENTITY.standby)
  }

  /** Queue course steps on the device: positive = starboard, negative = port */
  steps(count: number): Promise<void> {
    return this.post(`/number/${ENTITY.steps}/set?value=${Math.round(count)}`)
  }

  private async post(path: string) {
    if (!this.connected) {
      throw new Error('AC10 remote interface (ESPHome) is not connected')
    }
    const res = await this.request('POST', path, {
      signal: AbortSignal.timeout(this.requestMs)
    })
    await res.body?.cancel()
    if (!res.ok) {
      throw new Error(`ESPHome ${path} failed: HTTP ${res.status}`)
    }
  }

  /** fetch with Basic or Digest auth (ESPHome web_server supports both) */
  private async request(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; signal?: AbortSignal }
  ): Promise<Response> {
    const send = () =>
      this.fetchImpl(this.baseUrl + path, {
        method,
        signal: init.signal,
        headers: { ...init.headers, ...this.authHeader(method, path) }
      })
    let res = await send()
    const www = res.headers.get('www-authenticate')
    if (res.status === 401 && this.user && www && /^digest\s/i.test(www)) {
      await res.body?.cancel()
      this.digest = parseChallenge(www)
      this.nonceCount = 0
      res = await send()
    }
    return res
  }

  private authHeader(method: string, uri: string): Record<string, string> {
    if (!this.user) return {}
    const d = this.digest
    if (!d) {
      const token = Buffer.from(`${this.user}:${this.pass}`).toString('base64')
      return { Authorization: `Basic ${token}` }
    }
    const algo = /sha-256/i.test(d.algorithm ?? '') ? 'sha256' : 'md5'
    const h = (s: string) => createHash(algo).update(s).digest('hex')
    const ha1 = h(`${this.user}:${d.realm}:${this.pass}`)
    const ha2 = h(`${method}:${uri}`)
    const parts = [
      `username="${this.user}"`,
      `realm="${d.realm}"`,
      `nonce="${d.nonce}"`,
      `uri="${uri}"`
    ]
    let response: string
    if (d.qop && /\bauth\b/.test(d.qop)) {
      const nc = (++this.nonceCount).toString(16).padStart(8, '0')
      const cnonce = randomBytes(8).toString('hex')
      response = h(`${ha1}:${d.nonce}:${nc}:${cnonce}:auth:${ha2}`)
      parts.push('qop=auth', `nc=${nc}`, `cnonce="${cnonce}"`)
    } else {
      response = h(`${ha1}:${d.nonce}:${ha2}`)
    }
    parts.push(`response="${response}"`)
    if (d.opaque) parts.push(`opaque="${d.opaque}"`)
    if (d.algorithm) parts.push(`algorithm=${d.algorithm}`)
    return { Authorization: `Digest ${parts.join(', ')}` }
  }

  private async connect() {
    if (!this.running) return
    this.abort = new AbortController()
    try {
      const res = await this.request('GET', '/events', {
        headers: { Accept: 'text/event-stream' },
        signal: this.abort.signal
      })
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`)
      }
      this.touch()
      this.retryDelay = 1000
      this.connected = true
      this.emit('connected')
      await this.readStream(res.body)
      throw new Error('event stream closed')
    } catch (err) {
      this.setDisconnected(String((err as Error)?.message ?? err))
      if (this.running) {
        this.retryTimer = setTimeout(() => this.connect(), this.retryDelay)
        this.retryDelay = Math.min(this.retryDelay * 2, 15000)
      }
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      this.touch()
      buffer += decoder.decode(chunk, { stream: true })
      let idx: number
      while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '')
        this.handleEvent(block)
      }
    }
  }

  private handleEvent(block: string) {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (event !== 'state' || data.length === 0) return
    let msg: { id?: string; name_id?: string; value?: unknown; state?: unknown }
    try {
      msg = JSON.parse(data.join('\n'))
    } catch {
      return
    }
    // Older firmware: id "binary_sensor-ap_engaged"; newer: "binary_sensor/ap_engaged"
    const id = String(msg.name_id ?? msg.id ?? '')
    if (matches(id, 'binary_sensor', ENTITY.engaged)) {
      const engaged =
        typeof msg.value === 'boolean'
          ? msg.value
          : msg.state === 'ON'
            ? true
            : msg.state === 'OFF'
              ? false
              : undefined
      if (engaged !== this.engaged) {
        this.engaged = engaged
        this.emit('engaged', engaged)
      }
    } else if (matches(id, 'sensor', ENTITY.pendingSteps)) {
      const n = Number(msg.value)
      if (Number.isFinite(n)) {
        this.pendingSteps = n
        this.emit('pendingSteps', n)
      }
    }
  }

  private touch() {
    clearTimeout(this.staleTimer)
    this.staleTimer = setTimeout(() => {
      this.abort?.abort(new Error('no data from ESPHome (stale)'))
    }, this.staleMs)
  }

  private setDisconnected(reason: string) {
    clearTimeout(this.staleTimer)
    const was = this.connected
    this.connected = false
    if (this.engaged !== undefined) {
      this.engaged = undefined
      this.emit('engaged', undefined)
    }
    if (was) this.emit('disconnected', reason)
  }
}

interface DigestChallenge {
  realm: string
  nonce: string
  qop?: string
  opaque?: string
  algorithm?: string
}

function parseChallenge(header: string): DigestChallenge {
  const out: Record<string, string> = {}
  for (const m of header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3]
  }
  return {
    realm: out.realm ?? '',
    nonce: out.nonce ?? '',
    qop: out.qop,
    opaque: out.opaque,
    algorithm: out.algorithm
  }
}

function matches(id: string, domain: string, objectId: string) {
  return id === `${domain}-${objectId}` || id === `${domain}/${objectId}`
}
