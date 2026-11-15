// 纯逻辑单测，不需要真实 adbd：命令分级、一次性授权、设备解析、
// 握手探测（用本地假 adbd 服务器）、state 损坏恢复。
// 运行前先加载 test/preload.mjs 把 DSH_HOME 指到临时目录。
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import { probeAdb } from '../lib/adb.js'
import { judge, commandKey } from '../lib/risk.js'
import { allowOnce, hasGrant, consumeGrant, clearGrants } from '../lib/grants.js'
import { parseDevices, parseMdns } from '../lib/cli.js'
import { loadState, saveState, statePath, resetStateCache } from '../lib/state.js'
import { __test } from '../lib/index.js'

let failures = 0

function check(label, fn) {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${label} — ${error?.message ?? error}`)
  }
}

const tier = (args) => judge(args).tier

// 1. 命令分级。
check('devices is read-only', () => assert.equal(tier(['devices', '-l']), 'read'))
check('pm list is read-only', () => assert.equal(tier(['shell', 'pm', 'list', 'packages']), 'read'))
check('getprop is read-only', () => assert.equal(tier(['shell', 'getprop', 'ro.product.model']), 'read'))
check('dumpsys is read-only', () => assert.equal(tier(['shell', 'dumpsys', 'battery']), 'read'))
check('settings get is read-only', () => assert.equal(tier(['shell', 'settings', 'get', 'global', 'x']), 'read'))
check('logcat -c needs consent', () => assert.equal(tier(['shell', 'logcat', '-c']), 'confirm'))
check('exec-out screencap is read-only', () => assert.equal(tier(['exec-out', 'screencap', '-p']), 'read'))
check('logcat -f writes a file, needs consent', () => assert.equal(tier(['shell', 'logcat', '-f', '/sdcard/x.log']), 'confirm'))
check('logcat --file needs consent', () => assert.equal(tier(['shell', 'logcat', '--file', '/sdcard/x.log']), 'confirm'))
check('logcat -r needs consent', () => assert.equal(tier(['shell', 'logcat', '-f', '/sdcard/x.log', '-r', '100']), 'confirm'))
check('adb tcpip needs consent', () => assert.equal(tier(['tcpip', '3455']), 'confirm'))
check('adb pair is a link operation, no consent', () => assert.equal(tier(['pair', '192.168.1.5', '39235', '123456']), 'read'))
check('adb connect is a link operation', () => assert.equal(tier(['connect', '127.0.0.1:3455']), 'read'))
check('adb tcpip still needs consent', () => assert.equal(tier(['tcpip', '3455']), 'confirm'))
check('install needs consent', () => assert.equal(tier(['install', '/sdcard/x.apk']), 'confirm'))
check('input needs consent', () => assert.equal(tier(['shell', 'input', 'tap', '10', '20']), 'confirm'))
check('settings put needs consent', () => assert.equal(tier(['shell', 'settings', 'put', 'global', 'x', '1']), 'confirm'))
check('reboot needs consent', () => assert.equal(tier(['shell', 'reboot']), 'confirm'))
check('pm uninstall needs consent', () => assert.equal(tier(['shell', 'pm', 'uninstall', 'com.x']), 'confirm'))
check('rm is blocked', () => assert.equal(tier(['shell', 'rm', '-rf', '/sdcard/a']), 'blocked'))
check('rm inside one shell arg is blocked', () => assert.equal(tier(['shell', 'rm -rf /sdcard/a']), 'blocked'))
check('pm clear is blocked', () => assert.equal(tier(['shell', 'pm', 'clear', 'com.x']), 'blocked'))
check('sideload is blocked', () => assert.equal(tier(['sideload', 'x.zip']), 'blocked'))
check('dd to block device is blocked', () => assert.equal(tier(['shell', 'dd', 'if=/dev/zero', 'of=/dev/block/sda']), 'blocked'))

// 2. 命令指纹。
check('commandKey is stable', () => assert.equal(commandKey(['shell', 'echo', 'a']), commandKey(['shell', 'echo', 'a'])))
check('commandKey separates commands', () => assert.notEqual(commandKey(['shell', 'echo', 'a']), commandKey(['shell', 'echo', 'b'])))

// 3. 一次性授权。
clearGrants()
const key = commandKey(['install', '/sdcard/x.apk'])
check('no grant by default', () => assert.equal(hasGrant(key), false))
check('allowOnce grants', () => {
  allowOnce(key)
  assert.equal(hasGrant(key), true)
})
check('consumeGrant allows once', () => {
  assert.equal(consumeGrant(key), true)
  assert.equal(consumeGrant(key), false)
})
check('grant expires', () => {
  allowOnce(key, 1_000)
  assert.equal(hasGrant(key, Date.now() + 2_000), false)
})
clearGrants()

// 4. 设备解析与选择。
check('parseDevices parses -l output', () => {
  const devices = parseDevices([
    'List of devices attached',
    '127.0.0.1:3455       device product:x model:Pixel_7 device:panther transport_id:2',
    '127.0.0.1:5555       unauthorized usb:1-1',
    '',
  ].join('\n'))
  assert.equal(devices.length, 2)
  assert.equal(devices[0].serial, '127.0.0.1:3455')
  assert.equal(devices[0].model, 'Pixel_7')
  assert.equal(devices[1].state, 'unauthorized')
})
check('pickDevice prefers the remembered port', () => {
  const devices = [
    { serial: '127.0.0.1:5555', state: 'device' },
    { serial: '127.0.0.1:3455', state: 'device' },
  ]
  assert.equal(__test.pickDevice(devices, 3455).serial, '127.0.0.1:3455')
})
check('portOf extracts the tcp port', () => {
  assert.equal(__test.portOf('127.0.0.1:3455'), 3455)
  assert.equal(__test.portOf('emulator-5554'), null)
})

// 5. 假 adbd 握手：回 AUTH 的端口应被识别，其它端口不识别。
function fakeAdbd({ reply = true } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        if (!reply) {
          socket.destroy()
          return
        }
        const head = Buffer.alloc(24)
        head.writeUInt32LE(0x48545541, 0) // AUTH
        head.writeUInt32LE(0x01000000, 4)
        head.writeUInt32LE(256 * 1024, 8)
        head.writeUInt32LE(0, 12)
        head.writeUInt32LE(0, 16)
        head.writeUInt32LE((0x48545541 ^ 0xffffffff) >>> 0, 20)
        socket.write(head)
        socket.end()
      })
      socket.on('error', () => {})
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

const adbd = await fakeAdbd()
const silent = await fakeAdbd({ reply: false })
try {
  const yes = await probeAdb(adbd.port)
  check('probeAdb accepts an AUTH reply', () => assert.equal(yes, true))
  const no = await probeAdb(silent.port)
  check('probeAdb rejects a silent port', () => assert.equal(no, false))
} finally {
  adbd.server.close()
  silent.server.close()
}

// 6. state 损坏恢复与隔离。
check('state lives under the temporary DSH_HOME', () => {
  assert.ok(statePath.startsWith(process.env.DSH_HOME), statePath)
})
check('corrupted state falls back to defaults', () => {
  fs.mkdirSync(statePath.slice(0, statePath.lastIndexOf('/')), { recursive: true })
  fs.writeFileSync(statePath, '{not json')
  resetStateCache()
  const state = loadState()
  assert.equal(state.port, null)
  assert.equal(state.authorized, false)
  assert.equal(state.auto, true)
})
check('saveState round-trips', () => {
  saveState({ port: 3455, authorized: true })
  resetStateCache()
  const state = loadState()
  assert.equal(state.port, 3455)
  assert.equal(state.authorized, true)
})

// 6.5 mDNS 服务解析（无线调试配对/连接）。
check('parseMdns finds the TLS connect service', () => {
  const services = parseMdns('List of discovered mdns services\nadb-abc _adb-tls-connect._tcp. 192.168.1.5:37251\nadb-def _adb-tls-pairing._tcp. 192.168.1.5:39235\n')
  assert.equal(services.length, 2)
  assert.deepEqual(services[0].kind, 'connect')
  assert.deepEqual(services[0].address, '192.168.1.5:37251')
  assert.deepEqual(services[1].kind, 'pairing')
})
check('state keeps a TLS address', () => {
  saveState({ addr: '192.168.1.5:37251' })
  resetStateCache()
  assert.equal(loadState().addr, '192.168.1.5:37251')
  saveState({ addr: 'not an address' })
  resetStateCache()
  assert.equal(loadState().addr, '')
})

// 7. 面板视图与数据。
check('buildView renders the approve/deny actions', () => {
  const view = __test.buildView('zh')
  const text = JSON.stringify(view)
  assert.ok(text.includes('"action":"approve"'), 'approve action')
  assert.ok(text.includes('"action":"deny"'), 'deny action')
  assert.ok(text.includes('"action":"fixedPort"'), 'fixedPort action')
  assert.ok(text.includes('data.pendingNote'), 'pending binding')
})
check('panelDataFor carries pending fields', () => {
  const snap = { kind: 'connected', port: 3455, device: 'Pixel', adb: '/usr/bin/adb', auto: true, at: Date.now(), lastError: '' }
  const data = __test.panelDataFor(snap, 'zh')
  assert.equal(data.pending, '—')
  assert.ok(String(data.pendingNote).length > 0)
  assert.ok('recent' in data)
})
check('clipToolText truncates long output', () => {
  const long = __test.clipToolText('x'.repeat(20_000))
  assert.ok(long.length < 20_000)
  assert.ok(long.includes('已截断'))
})

console.log(failures === 0 ? '\nall unit checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
