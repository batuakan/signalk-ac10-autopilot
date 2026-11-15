/*
 * Signal K plugin: Simrad AC10 autopilot.
 *
 * Exposes the same interface as @signalk/signalk-autopilot, so its clients
 * (its remote-control webapp, KIP, Freeboard, WilhelmSK, ...) work unchanged:
 *
 *   PUT steering.autopilot.state                    standby | auto | wind | route
 *   PUT steering.autopilot.target.headingMagnetic   degrees
 *   PUT steering.autopilot.target.windAngleApparent degrees
 *   PUT steering.autopilot.actions.adjustHeading    degrees (+ = starboard)
 *   PUT steering.autopilot.actions.tack             port | starboard
 *   PUT steering.autopilot.actions.advanceWaypoint  any
 *   Signal K v2 Autopilot API provider
 */

import type {
  ActionResult,
  AutopilotInfo,
  AutopilotProvider,
  Plugin,
  ServerAPI
} from '@signalk/server-api'
import { AC10Pilot, DEFAULT_CONFIG, PilotApp, PilotConfig, Remote } from './ac10'
import { EspHomeRemote } from './esphome'
import { DEFAULT_PREFIX, SignalKRemote, SignalKRemoteApp } from './signalk-remote'
import { degToRad, radToDeg } from './angles'

const PLUGIN_ID = 'ac10-autopilot'
const DEVICE_ID = 'ac10'

interface Settings {
  transport: 'signalk' | 'http'
  signalkPrefix: string
  esphomeHost: string
  esphomePort: number
  esphomeUsername: string
  esphomePassword: string
  engagedMode: 'auto' | 'wind'
  confirmTimeout: number
  maxAdjust: number
  tackAngle: number
  enableV2API: boolean
  route: Partial<PilotConfig['route']>
}

type PutCallback = (res: ActionResult) => void

export = function (app: ServerAPI & PilotApp): Plugin {
  let pilot: AC10Pilot | undefined
  let remote: Remote | undefined
  let lastEngagedState = 'auto'

  /** Run an async command as a Signal K PUT: reply PENDING, complete later */
  const put =
    (fn: (value: unknown) => Promise<void>) =>
    (_ctx: string, _path: string, value: unknown, cb: PutCallback): ActionResult => {
      if (!pilot) return { state: 'COMPLETED', statusCode: 503, message: 'Plugin not started' }
      // The server records the returned PENDING in a later microtask; a callback before that (a command
      // that fails or finishes at once) would be overwritten by it and the request would stay PENDING.
      // So complete from a macrotask.
      const complete = (res: ActionResult) => setImmediate(() => cb(res))
      fn(value).then(
        () => complete({ state: 'COMPLETED', statusCode: 200 }),
        (err: Error) => {
          app.debug('PUT failed: ' + err.message)
          complete({ state: 'COMPLETED', statusCode: 400, message: err.message })
        }
      )
      return { state: 'PENDING', statusCode: 202 }
    }

  const need = () => {
    if (!pilot) throw new Error('Plugin not started')
    return pilot
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Simrad AC10 Autopilot',
    description:
      'Controls a Simrad AC10 autopilot through an ESPHome R3000X remote-port interface and NMEA 0183',

    start(raw: object) {
      const s = raw as Partial<Settings>
      const transport = s.transport ?? 'signalk'
      if (transport === 'http' && !s.esphomeHost) {
        app.setPluginError('Set the ESPHome device host name or IP address')
        return
      }
      const cfg: PilotConfig = {
        ...DEFAULT_CONFIG,
        engagedMode: s.engagedMode ?? DEFAULT_CONFIG.engagedMode,
        confirmTimeout: s.confirmTimeout ?? DEFAULT_CONFIG.confirmTimeout,
        maxAdjust: s.maxAdjust ?? DEFAULT_CONFIG.maxAdjust,
        tackAngle: s.tackAngle ?? DEFAULT_CONFIG.tackAngle,
        route: { ...DEFAULT_CONFIG.route, ...(s.route ?? {}) }
      }

      const r: Remote =
        transport === 'http'
          ? new EspHomeRemote({
              host: s.esphomeHost!,
              port: s.esphomePort,
              username: s.esphomeUsername,
              password: s.esphomePassword
            })
          : new SignalKRemote(app as unknown as SignalKRemoteApp, { prefix: s.signalkPrefix })
      remote = r
      pilot = new AC10Pilot(app, r, cfg, PLUGIN_ID)
      lastEngagedState = cfg.engagedMode

      r.on('connected', () => app.setPluginStatus(`AC10 remote interface online (${r.description})`))
      r.on('disconnected', (reason: string) =>
        app.setPluginError(`AC10 remote interface (${r.description}): ${reason}`)
      )

      const self = 'vessels.self'
      const reg = (path: string, fn: (v: unknown) => Promise<void>) =>
        app.registerPutHandler(self, path, put(fn) as never, PLUGIN_ID)

      reg('steering.autopilot.state', (v) => need().setState(String(v)))
      reg('steering.autopilot.target.headingMagnetic', (v) =>
        need().setTargetHeading(degToRad(Number(v)))
      )
      reg('steering.autopilot.target.windAngleApparent', (v) =>
        need().setTargetWind(degToRad(Number(v)))
      )
      reg('steering.autopilot.actions.adjustHeading', (v) => need().adjust(Number(v)))
      reg('steering.autopilot.actions.tack', (v) => need().tack(v as 'port'))
      reg('steering.autopilot.actions.advanceWaypoint', () => need().nextPoint())

      if (s.enableV2API !== false) registerProvider(pilot)

      pilot.start()
      try {
        r.start()
      } catch (err) {
        app.setPluginError(`Could not start the AC10 remote interface: ${(err as Error).message}`)
        plugin.stop()
        return
      }
      app.setPluginStatus(`Waiting for the AC10 remote interface (${r.description})`)
    },

    stop() {
      pilot?.stop()
      remote?.stop()
      pilot = undefined
      remote = undefined
    },

    schema: () => ({
      type: 'object',
      properties: {
        transport: {
          type: 'string',
          title: 'How to reach the AC10 remote interface (ESP32)',
          description:
            'signalk: the ESP runs ESPHomeSignalK and takes PUTs through this server. ' +
            'http: the plugin talks to the ESPHome web server directly.',
          enum: ['signalk', 'http'],
          enumNames: ['Through Signal K (ESPHomeSignalK)', 'ESPHome web server (HTTP)'],
          default: 'signalk'
        },
        signalkPrefix: {
          type: 'string',
          title: 'Signal K path prefix of the device (signalk transport)',
          default: DEFAULT_PREFIX
        },
        esphomeHost: {
          type: 'string',
          title: 'ESPHome device host (http transport)',
          description: 'Host name or IP of the AC10 remote interface, e.g. ac10-remote.local'
        },
        esphomePort: { type: 'number', title: 'ESPHome web server port (http)', default: 80 },
        esphomeUsername: { type: 'string', title: 'ESPHome web server username (http)', default: '' },
        esphomePassword: { type: 'string', title: 'ESPHome web server password (http)', default: '' },
        engagedMode: {
          type: 'string',
          title: 'Mode entered by the remote STBY-AUTO key',
          description:
            'Must match the AC10 control unit User Setup: AUTO, or WIND if WIND is selected there',
          enum: ['auto', 'wind'],
          default: 'auto'
        },
        confirmTimeout: {
          type: 'number',
          title: 'State change confirmation timeout (s)',
          default: DEFAULT_CONFIG.confirmTimeout
        },
        maxAdjust: {
          type: 'number',
          title: 'Largest single course change (degrees)',
          default: DEFAULT_CONFIG.maxAdjust
        },
        tackAngle: {
          type: 'number',
          title: 'Tack angle in AUTO (degrees, 0 = disabled)',
          description: 'In WIND mode the tack mirrors the apparent wind angle instead',
          default: DEFAULT_CONFIG.tackAngle
        },
        enableV2API: {
          type: 'boolean',
          title: 'Enable Autopilot V2 API',
          description: 'Disable this if KIP should use the v1 PUT paths',
          default: true
        },
        route: {
          type: 'object',
          title: 'Route following (plugin-steered, AC10 in AUTO)',
          properties: {
            enabled: { type: 'boolean', title: 'Enable route state', default: true },
            interval: { type: 'number', title: 'Correction interval (s)', default: 2 },
            xteLookahead: { type: 'number', title: 'XTE lookahead (m)', default: 100 },
            maxXteCorrection: {
              type: 'number',
              title: 'Max XTE correction (degrees)',
              default: 45
            },
            maxStepsPerCycle: {
              type: 'number',
              title: 'Max course change per correction (degrees)',
              default: 3
            },
            deadband: { type: 'number', title: 'Deadband (degrees)', default: 1 },
            dataTimeout: {
              type: 'number',
              title: 'Course data timeout before reverting to AUTO (s)',
              default: 10
            }
          }
        }
      }
    })
  }

  function registerProvider(p: AC10Pilot) {
    const info = (): AutopilotInfo => {
      const st = p.status
      return {
        options: { states: p.states(), modes: [], actions: actions(st.state) },
        state: st.state,
        mode: null,
        engaged: st.engaged,
        target: st.target
      }
    }
    const actions = (state: string | null) => [
      { id: 'tack' as const, name: 'Tack', available: state === 'auto' || state === 'wind' },
      { id: 'courseNextPoint' as const, name: 'Advance Waypoint', available: state === 'route' }
    ]
    const unsupported = async () => {
      throw new Error('Not supported by the AC10 remote port')
    }

    const provider: AutopilotProvider = {
      getData: async () => info(),
      getState: async () => p.status.state as string,
      setState: (state) => p.setState(state),
      getMode: async () => null as unknown as string,
      setMode: unsupported,
      getTarget: async () => p.status.target as number,
      setTarget: (value) =>
        p.status.state === 'wind' ? p.setTargetWind(value) : p.setTargetHeading(value),
      adjustTarget: (value) => p.adjust(radToDeg(value)),
      engage: () => p.setState(lastEngagedState),
      disengage: () => p.setState('standby'),
      tack: (direction) => p.tack(direction),
      gybe: unsupported,
      dodge: unsupported,
      courseCurrentPoint: unsupported,
      courseNextPoint: () => p.nextPoint()
    }
    try {
      app.registerAutopilotProvider(provider, [DEVICE_ID])
    } catch (err) {
      app.error('Autopilot V2 API registration failed: ' + (err as Error).message)
      return
    }
    p.on('update', (st) => {
      if (st.state && st.state !== 'standby') lastEngagedState = st.state
      app.autopilotUpdate(DEVICE_ID, {
        state: st.state,
        engaged: st.engaged,
        target: st.target
      })
    })
  }

  return plugin
}
