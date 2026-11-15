import { expect } from 'chai'
import createPlugin from '../src/index'

const PATHS = [
  'steering.autopilot.state',
  'steering.autopilot.target.headingMagnetic',
  'steering.autopilot.target.windAngleApparent',
  'steering.autopilot.actions.adjustHeading',
  'steering.autopilot.actions.tack',
  'steering.autopilot.actions.advanceWaypoint'
]

function fakeApp() {
  const app = {
    puts: [] as string[],
    providers: [] as string[][],
    status: '',
    error: '',
    debug() {},
    setPluginStatus: (m: string) => (app.status = m),
    setPluginError: (m: string) => (app.error = m),
    getSelfPath() {},
    handleMessage() {},
    registerPutHandler: (_ctx: string, path: string) => app.puts.push(path),
    registerAutopilotProvider: (_p: unknown, devices: string[]) => app.providers.push(devices),
    autopilotUpdate() {},
    putSelfPath: async () => ({ state: 'COMPLETED', statusCode: 200 }),
    streambundle: { getSelfBus: () => ({ onValue: () => () => {} }) }
  }
  return app
}

describe('plugin', () => {
  it('registers the signalk-autopilot PUT paths and a V2 provider (signalk transport)', () => {
    const app = fakeApp()
    const plugin = createPlugin(app as never)
    plugin.start({}, () => {})
    plugin.stop()
    expect(app.puts).to.have.members(PATHS)
    expect(app.providers).to.deep.equal([['ac10']])
    expect(app.status).to.match(/steering\.autopilot\.ac10/)
  })

  it('works with the http transport', () => {
    const app = fakeApp()
    const plugin = createPlugin(app as never)
    plugin.start({ transport: 'http', esphomeHost: '127.0.0.1', esphomePort: 9 }, () => {})
    plugin.stop()
    expect(app.puts).to.have.members(PATHS)
    expect(app.status).to.match(/127\.0\.0\.1:9/)
  })

  it('needs a host for the http transport', () => {
    const app = fakeApp()
    const plugin = createPlugin(app as never)
    plugin.start({ transport: 'http' }, () => {})
    expect(app.error).to.match(/host/)
    expect(app.puts).to.deep.equal([])
  })

  it('reports an error and stops cleanly when the server has no streambundle', () => {
    const app = fakeApp() as Partial<ReturnType<typeof fakeApp>>
    delete app.streambundle
    const plugin = createPlugin(app as never)
    plugin.start({}, () => {})
    expect(app.error).to.match(/streambundle/)
  })
})
