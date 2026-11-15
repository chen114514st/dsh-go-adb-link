// local-adb-link —— 找到本机手机上 Shizuku/Stellar 的 TCP ADB 端口并保持 adb
// 连接，这样 DSH 的 bash 调用可以直接使用 `adb shell`，不必再手动输入端口。
//
// 手机之所以可连，是因为 Shizuku 一类的管理器（Stellar，Shizuku 的分支）或
// `adb tcpip <端口>` 会让 adbd 监听 TCP。本插件会：
//   1. 用 ADB 握手探测记住的端口和常见候选端口（lib/adb.js，纯 Node 实现，
//      搜索时不需要 adb 二进制）；
//   2. 按钮触发时退化为扫描本机全部端口；
//   3. 执行 `adb connect`，等待密钥授权（手机上会弹一次“允许调试”），
//      并把端口记进 state.json；
//   4. 之后每次引擎启动都自动重连，随后 bash 里的 `adb` 就通过 127.0.0.1:5037
//      上的共享 adb server 通信。
import fs from 'node:fs'
import path from 'node:path'
import { findAdbPorts, probeAdb } from './adb.js'
import { adbConnect, adbDevices, adbDisconnect, adbMdns, adbPair, adbStartServer, adbTcpip, formatHostPort, installAdb, resolveAdb, run } from './cli.js'
import { allowOnce, clearGrants, consumeGrant, hasGrant } from './grants.js'
import { commandKey, judge } from './risk.js'
import { loadState, saveState, statePath } from './state.js'

export const name = 'dsh-go-adb-link'

const KNOWN_PORTS = [3455, 5555]
const PORT_EXCLUDE = [3080, 5037]
const SCAN_START = 1
const SCAN_END = 65535
const SCAN_CONCURRENCY = 400
const SCAN_TIMEOUT_MS = 280
const AUTO_COOLDOWN_MS = 90_000
const AUTH_COOLDOWN_MS = 10 * 60_000
const SCAN_RETRY_MS = 10 * 60_000
const PANEL_POLL_MS = 6_000
const STRIP_POLL_MS = 12_000
const CONNECT_WAIT_MS = 45_000
const CONNECT_WAIT_PENDING_MS = 20_000
const FIXED_PORT = 3455

// ── 文案 ──────────────────────────────────────────────────────────────────

const DICT = {
  zh: {
    plugin: 'ADB 自动连接',
    status: {
      connected: '已连接',
      checking: '检查中',
      connecting: '连接中',
      scanning: '扫描端口',
      installing: '安装 adb',
      waiting: '等待授权',
      disconnected: '未连接',
      noadb: '缺 adb 客户端',
    },
    strip: {
      connected: (port) => `ADB 已连接 · ${port}`,
      checking: 'ADB 检查中…',
      connecting: 'ADB 连接中…',
      scanning: '正在扫描端口…',
      installing: '正在装 adb…',
      waiting: 'ADB 待授权 · 点按',
      tcpip: '正在固定端口…',
      disconnected: 'ADB 未连接 · 点按',
      noadb: '缺 adb 客户端 · 点按',
    },
    note: {
      connected: 'ADB 通道已就绪，本机可直接执行 adb 命令。',
      checking: '正在检查 adb 状态…',
      connecting: '正在连接手机上的 ADB 端口…',
      scanning: '正在扫描本机端口，寻找 ADB 服务…',
      installing: '本机缺少 adb 客户端，正在自动安装…',
      waiting: '请在手机上点“允许”，并勾选“始终允许这台计算机”。',
      tcpip: '正在把 adbd 固定到 3455；adbd 会重启一次，连接会短暂断开。',
      disconnected: '点“连接”自动找到手机上的 ADB 端口并连上。',
      noadb: '本机没有 adb 客户端，点“连接”会自动安装。',
    },
    key: {
      status: '状态', port: '端口', device: '设备', adb: '客户端', auto: '自动重连',
      pending: '待允许', recent: '最近 AI 命令', last: '上次错误',
    },
    btn: { connect: '连接', scan: '扫描端口', fixedPort: '固定端口', disconnect: '断开', copy: '复制命令', approve: '允许一次', deny: '拒绝' },
    hint: '首次连接：在手机上点“允许”并勾选“始终允许这台计算机”，之后每次启动自动重连。',
    fixedHint: '「固定端口」让 adbd 改为监听 3455，只对本次开机有效；手机重启或 adbd 重启后需要再点一次。',
    ai: 'AI 用 adb 前会先说明目的；系统级或写入操作须经你同意。',
    pendingNote: (command) => `AI 想执行系统级命令：${command}。这是写入或系统级操作，点「允许一次」放行这一次。`,
    noPending: '当前没有等待确认的 AI 命令。',
    on: '开',
    off: '关',
    none: '未找到',
    pending: { connect: '连接 ADB', scan: '扫描 ADB 端口', fixedPort: '固定 ADB 端口' },
    toast: {
      connected: (port) => `ADB 已连接 · ${port}`,
      already: 'ADB 已经连着了',
      unauthorized: '请在手机上点“允许调试”',
      noPort: '没找到 ADB 端口，请确认 Stellar 的 TCP 已开',
      installFailed: '自动安装 adb 失败，请手动安装',
      noAdb: '本机没有 adb 客户端',
      timeout: '连接 ADB 超时，请重试',
      disconnected: '已断开 ADB，不会再自动重连',
      copied: '命令已复制',
      cancelled: '已取消',
      approved: '已允许一次，AI 可以按原命令重试',
      denied: '已拒绝这条命令',
      nothingPending: '当前没有待确认的命令',
      blocked: '这条命令属于红线操作，不能通过 adb 执行',
      fixedPort: (port) => `adbd 已固定监听 ${port}`,
      fixedPortNoTransport: '当前没有可用传输：先连接或插 USB，再固定端口',
      fixedPortFail: '固定端口失败，adb tcpip 没有生效',
      fixedPortTimeout: '端口已切换，但暂时没连上，稍后会自动重连',
    },
  },
  en: {
    plugin: 'ADB auto-link',
    status: {
      connected: 'Connected',
      checking: 'Checking',
      connecting: 'Connecting',
      scanning: 'Scanning',
      installing: 'Installing',
      waiting: 'Waiting',
      disconnected: 'Offline',
      noadb: 'No adb client',
    },
    strip: {
      connected: (port) => `ADB connected · ${port}`,
      checking: 'ADB checking…',
      connecting: 'ADB connecting…',
      scanning: 'Scanning ports…',
      installing: 'Installing adb…',
      waiting: 'ADB needs allow · tap',
      tcpip: 'Pinning the port…',
      disconnected: 'ADB offline · tap',
      noadb: 'No adb client · tap',
    },
    note: {
      connected: 'The ADB channel is ready; this machine can run adb now.',
      checking: 'Checking the adb state…',
      connecting: 'Connecting to the phone ADB port…',
      scanning: 'Scanning localhost for an ADB service…',
      installing: 'The adb client is missing; installing it…',
      waiting: 'Tap “Allow” and tick “Always allow from this computer”.',
      tcpip: 'Pinning adbd to 3455; adbd restarts and the link drops for a moment.',
      disconnected: 'Tap “Connect” to find the phone ADB port and link it.',
      noadb: 'No adb client on this machine; “Connect” installs it.',
    },
    key: {
      status: 'State', port: 'Port', device: 'Device', adb: 'Client', auto: 'Reconnect',
      pending: 'Pending', recent: 'Last AI command', last: 'Last error',
    },
    btn: { connect: 'Connect', scan: 'Scan ports', fixedPort: 'Fix port', disconnect: 'Disconnect', copy: 'Copy command', approve: 'Allow once', deny: 'Deny' },
    hint: 'First time: tap “Allow” and tick “Always allow” on the phone; then it reconnects by itself.',
    fixedHint: '“Fix port” makes adbd listen on 3455 until the phone or adbd restarts; tap it again after a reboot.',
    ai: 'The AI explains what it will run first; system-level or write operations need your consent.',
    pendingNote: (command) => `The AI wants to run a system-level command: ${command}. Tap “Allow once” to let this one through.`,
    noPending: 'No AI command is waiting for consent.',
    on: 'on',
    off: 'off',
    none: 'not found',
    pending: { connect: 'Connecting ADB', scan: 'Scanning ADB ports', fixedPort: 'Fixing the ADB port' },
    toast: {
      connected: (port) => `ADB connected · ${port}`,
      already: 'ADB is already connected',
      unauthorized: 'Tap “Allow” in the dialog on the phone',
      noPort: 'No ADB port found; check Stellar TCP debugging',
      installFailed: 'Could not install adb; install it manually',
      noAdb: 'No adb client on this machine',
      timeout: 'ADB connect timed out; try again',
      disconnected: 'ADB disconnected; auto-reconnect is off',
      copied: 'Command copied',
      cancelled: 'Cancelled',
      approved: 'Allowed once; the AI can retry the same command',
      denied: 'Denied that command',
      nothingPending: 'No command is waiting for consent',
      blocked: 'That command is on the red-line list and cannot run through adb',
      fixedPort: (port) => `adbd now listens on ${port}`,
      fixedPortNoTransport: 'No transport right now: connect or plug in USB first',
      fixedPortFail: 'Fixing the port failed; adb tcpip did not take effect',
      fixedPortTimeout: 'Port switched, but the link is not up yet; it will retry',
    },
  },
}

const dict = (locale) => (String(locale ?? '').toLowerCase().startsWith('en') ? DICT.en : DICT.zh)

// ── 运行时状态 ─────────────────────────────────────────────────────────

/** `busy` 是设备列表尚未刷新时展示的进行中步骤。 */
const rt = {
  busy: null,
  snapshot: null,
  lastKnown: null,
  snapshotAt: 0,
  snapshotInflight: null,
  inflight: null,
  lastAutoAt: 0,
  lastScanAt: 0,
  lastServerAt: 0,
  pending: null,
  recent: [],
}
const listeners = new Set()

function bump() {
  for (const callback of [...listeners]) {
    try { callback() } catch {}
  }
}

function subscribeLive(callback) {
  listeners.add(callback)
  return () => { listeners.delete(callback) }
}

function invalidate() {
  rt.snapshot = null
  rt.snapshotAt = 0
}

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

const portOf = (serial) => {
  const match = /:(\d+)$/.exec(String(serial))
  const port = match ? Number(match[1]) : NaN
  return Number.isInteger(port) && port > 0 ? port : null
}

const isTcpSerial = (serial) => /:\d+$/.test(serial) && !String(serial).startsWith('emulator-')

function pickDevice(devices, port) {
  const tcp = devices.filter((device) => isTcpSerial(device.serial))
  if (port) {
    const exact = tcp.find((device) => portOf(device.serial) === port)
    if (exact) return exact
  }
  return tcp.find((device) => device.state === 'device')
    ?? tcp.find((device) => device.state === 'unauthorized' || device.state === 'authorizing')
    ?? null
}

function clockOf(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 读取一次“adb 现在是什么状态”。结果会短期缓存，避免状态条和面板轮询
 * 各自启动一个 adb 客户端；并发调用共享同一次读取。
 */
async function snapshot({ ttl = 1500 } = {}) {
  const now = Date.now()
  if (rt.snapshot !== null && now - rt.snapshotAt < ttl) return rt.snapshot
  if (rt.snapshotInflight) return rt.snapshotInflight
  rt.snapshotInflight = readSnapshot(now).finally(() => {
    rt.snapshotInflight = null
  })
  return rt.snapshotInflight
}

async function readSnapshot(now) {
  const stored = loadState()
  const adb = resolveAdb()
  const out = {
    kind: 'disconnected',
    adb,
    port: stored.port,
    serial: null,
    device: '',
    at: now,
    auto: stored.auto !== false,
    authorized: stored.authorized === true,
    busy: rt.busy,
    lastError: stored.lastError || '',
  }
  try {
    const devices = adb ? await adbDevices(adb) : []
    const mine = pickDevice(devices, stored.port)
    if (mine && mine.state === 'device') {
      out.kind = 'connected'
      out.serial = mine.serial
      out.port = portOf(mine.serial) ?? stored.port
      out.device = [mine.model, mine.device].filter(Boolean).join(' · ') || mine.serial
    } else if (mine && (mine.state === 'unauthorized' || mine.state === 'authorizing')) {
      out.kind = 'waiting-auth'
      out.serial = mine.serial
      out.port = portOf(mine.serial) ?? stored.port
    } else if (!adb) {
      out.kind = rt.busy ?? 'no-adb'
    } else {
      out.kind = rt.busy ?? 'disconnected'
    }
  } catch {
    if (!adb) out.kind = 'no-adb'
  }
  rt.snapshot = out
  rt.lastKnown = out
  rt.snapshotAt = now
  return out
}

// ── 建立连接 ────────────────────────────────────────────────────────────

async function discoverPort(stored, { scan, signal }) {
  const candidates = [...new Set([stored.port, ...KNOWN_PORTS].filter((port) => Number.isInteger(port)))]
  for (const port of candidates) {
    if (signal?.aborted) return null
    if (await probeAdb(port, { timeoutMs: 700 })) return port
  }
  if (!scan) return null
  rt.busy = 'scanning'
  bump()
  invalidate()
  const found = await findAdbPorts({
    candidatePorts: candidates,
    start: SCAN_START,
    end: SCAN_END,
    concurrency: SCAN_CONCURRENCY,
    timeoutMs: SCAN_TIMEOUT_MS,
    exclude: PORT_EXCLUDE,
    signal,
  })
  return found[0] ?? null
}

/**
 * 确保 adb 可用；找到手机的 adbd 就连接，并等待密钥授权。
 * 始终返回一个普通结果对象，不会抛异常。
 */
async function doConnect({ scan = true, install = true, waitMs = CONNECT_WAIT_MS, signal } = {}) {
  let adb = resolveAdb()
  if (!adb && install) {
    rt.busy = 'installing'
    bump()
    invalidate()
    const installed = await installAdb({ signal })
    adb = resolveAdb()
    if (!adb) return { ok: false, reason: 'install-failed', detail: installed.detail }
  }
  if (!adb) return { ok: false, reason: 'no-adb' }

  const before = await snapshot({ ttl: 0 })
  if (before.kind === 'connected') {
    saveState({ port: before.port, authorized: true, lastAt: Date.now(), authWaitUntil: 0, lastError: '' })
    return { ok: true, already: true, port: before.port, device: before.device }
  }

  const stored = loadState()
  let port = null
  let connected = null
  let viaAddr = false
  if (stored.addr) {
    // Android 11+ 无线调试：TLS 端口不响应 ADB 握手，记下的地址直接 connect。
    rt.busy = 'connecting'
    bump()
    invalidate()
    const tls = await adbConnect(stored.addr, { signal })
    if (tls.ok) {
      port = portOf(stored.addr)
      connected = tls
      viaAddr = true
    }
  }
  if (port === null) {
    port = await discoverPort(stored, { scan, signal })
    if (port === null) return { ok: false, reason: 'no-port' }

    rt.busy = 'connecting'
    bump()
    invalidate()
    connected = await adbConnect(port, { signal })
  }

  const deadline = Date.now() + waitMs
  let sawUnauthorized = false
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, reason: 'cancelled' }
    const devices = await adbDevices(adb)
    const mine = pickDevice(devices, port)
    if (mine && mine.state === 'device') {
      saveState({ port, authorized: true, auto: true, lastAt: Date.now(), authWaitUntil: 0, lastError: '', ...(viaAddr ? {} : { addr: '' }) })
      invalidate()
      return {
        ok: true,
        port,
        device: [mine.model, mine.device].filter(Boolean).join(' · ') || mine.serial,
      }
    }
    if (mine && (mine.state === 'unauthorized' || mine.state === 'authorizing')) {
      sawUnauthorized = true
      if (rt.busy !== 'waiting-auth') {
        rt.busy = 'waiting-auth'
        bump()
        invalidate()
      }
    }
    await sleep(1200)
  }

  if (sawUnauthorized) {
    saveState({ port, authorized: false, lastAt: Date.now(), authWaitUntil: Date.now() + AUTH_COOLDOWN_MS, lastError: 'unauthorized' })
    return { ok: false, reason: 'unauthorized', port }
  }
  saveState({ lastAt: Date.now(), lastError: connected.ok ? 'no-device' : 'connect-failed' })
  return { ok: false, reason: 'timeout', port, detail: connected.detail }
}

/** 同一时间只跑一次连接；并发调用者共享同一次尝试。 */
function connectOnce(options) {
  if (rt.inflight) return rt.inflight
  rt.inflight = doConnect(options)
    .catch((error) => ({ ok: false, reason: 'error', detail: String(error?.message ?? error) }))
    .finally(() => {
      rt.inflight = null
      rt.busy = null
      invalidate()
      bump()
    })
  return rt.inflight
}

/** 记录轮询发现的在线连接，供下次启动重连使用。 */
function remember(snap) {
  if (snap.kind !== 'connected' || !snap.port) return
  const stored = loadState()
  if (stored.port === snap.port && stored.authorized === true) return
  saveState({ port: snap.port, authorized: true, authWaitUntil: 0, lastError: '' })
  invalidate()
}

/** 引擎启动后或状态条挂载时，静默重连一次。 */
function maybeAutoConnect() {
  const now = Date.now()
  if (now - rt.lastAutoAt < AUTO_COOLDOWN_MS) return
  rt.lastAutoAt = now
  const stored = loadState()
  if (stored.auto === false) return
  if (now < stored.authWaitUntil) return
  if (rt.inflight) return
  if (!resolveAdb()) return
  connectOnce({ scan: false, install: false, waitMs: 6_000 }).then((result) => {
    // 记住的端口不通，但之前配过对：端口可能变了（重启 / Stellar 重启）。
    // 重新找一次，最多每 10 分钟一次。
    if (result?.ok || result?.reason !== 'no-port') return
    if (loadState().authorized !== true) return
    if (Date.now() - rt.lastScanAt < SCAN_RETRY_MS) return
    rt.lastScanAt = Date.now()
    connectOnce({ scan: true, install: false, waitMs: 6_000 }).catch(() => {})
  }).catch(() => {})
}

// ── 副作用 ───────────────────────────────────────────────────────────────

function patchFor(result, locale) {
  const d = dict(locale)
  if (result.ok) {
    return {
      note: d.note.connected,
      tone: 'good',
      status: d.status.connected,
      port: String(result.port ?? '—'),
      device: result.device || '—',
      adb: resolveAdb() || d.none,
      auto: d.on,
      checked: clockOf(Date.now()),
    }
  }
  const reason = result.reason
  const patch = { checked: clockOf(Date.now()) }
  if (reason === 'unauthorized') {
    Object.assign(patch, { note: d.note.waiting, tone: 'warn', status: d.status.waiting, port: String(result.port ?? '—') })
  } else if (reason === 'no-port') {
    Object.assign(patch, { note: d.note.disconnected, tone: 'muted', status: d.status.disconnected })
  } else if (reason === 'no-adb' || reason === 'install-failed') {
    Object.assign(patch, { note: d.note.noadb, tone: 'bad', status: d.status.noadb, adb: d.none })
  } else {
    Object.assign(patch, { note: d.note.disconnected, tone: 'muted', status: d.status.disconnected })
  }
  return patch
}

function toastFor(result, locale) {
  const t = dict(locale).toast
  switch (result.reason) {
    case 'unauthorized': return t.unauthorized
    case 'no-port': return t.noPort
    case 'no-adb': return t.noAdb
    case 'install-failed': return t.installFailed
    case 'cancelled': return t.cancelled
    default: return t.timeout
  }
}

function connectHandler(scope, event) {
  const d = dict(event?.locale)
  return {
    pending: { label: d.pending.connect, timeoutMs: 58_000 },
    result: async (signal) => {
      const result = await connectOnce({ scan: true, install: true, waitMs: CONNECT_WAIT_PENDING_MS, signal })
      if (result.ok) {
        return { toast: result.already ? d.toast.already : d.toast.connected(result.port), patch: patchFor(result, event?.locale) }
      }
      return { toast: toastFor(result, event?.locale), patch: patchFor(result, event?.locale) }
    },
  }
}

function scanHandler(scope, event) {
  const d = dict(event?.locale)
  return {
    pending: { label: d.pending.scan, timeoutMs: 58_000 },
    result: async (signal) => {
      try {
        const stored = loadState()
        rt.busy = 'scanning'
        bump()
        invalidate()
        const found = await findAdbPorts({
          candidatePorts: [stored.port, ...KNOWN_PORTS].filter(Boolean),
          start: SCAN_START,
          end: SCAN_END,
          concurrency: SCAN_CONCURRENCY,
          timeoutMs: SCAN_TIMEOUT_MS,
          exclude: PORT_EXCLUDE,
          signal,
        })
        if (found.length === 0) {
          rt.busy = null
          invalidate()
          return { toast: d.toast.noPort, patch: patchFor({ ok: false, reason: 'no-port' }, event?.locale) }
        }
        saveState({ port: found[0] })
        const result = await connectOnce({ scan: false, install: false, waitMs: 15_000, signal })
        if (result.ok) return { toast: d.toast.connected(result.port), patch: patchFor(result, event?.locale) }
        return { toast: toastFor(result, event?.locale), patch: patchFor(result, event?.locale) }
      } finally {
        rt.busy = null
        invalidate()
        bump()
      }
    },
  }
}

async function disconnectHandler(scope, event) {
  const d = dict(event?.locale)
  const stored = loadState()
  await adbDisconnect(stored.port, { timeoutMs: 2_400 })
  saveState({ auto: false, authWaitUntil: 0, lastError: '' })
  invalidate()
  const snap = await snapshot({ ttl: 0 })
  return {
    toast: d.toast.disconnected,
    patch: {
      note: d.note.disconnected,
      tone: 'muted',
      status: d.status.disconnected,
      auto: d.off,
      port: snap.port ? String(snap.port) : '—',
      checked: clockOf(Date.now()),
    },
  }
}

function copyHandler(scope, event) {
  const d = dict(event?.locale)
  const port = loadState().port ?? KNOWN_PORTS[0]
  const home = process.env.HOME || '/root'
  return {
    copy: `export HOME=${home}; adb connect 127.0.0.1:${port}\n`,
    toast: d.toast.copied,
  }
}

/** 用户在面板点「允许一次」：放行当前待确认命令，之后执行时消费掉。 */
function approveHandler(scope, event) {
  const d = dict(event?.locale)
  if (!rt.pending) return { toast: d.toast.nothingPending }
  allowOnce(rt.pending.key)
  rt.pending = null
  invalidate()
  bump()
  return { toast: d.toast.approved }
}

/** 用户在面板点「拒绝」：清掉待确认命令，AI 的重试仍会被拦。 */
function denyHandler(scope, event) {
  const d = dict(event?.locale)
  if (!rt.pending) return { toast: d.toast.nothingPending }
  clearGrants()
  rt.pending = null
  invalidate()
  bump()
  return { toast: d.toast.denied }
}

/** 等 adbd 在某个端口重新开始监听（`adb tcpip` 会重启 adbd，端口短暂消失）。 */
async function waitForPort(port, timeoutMs = 12_000, signal) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return false
    try {
      if (await probeAdb(port, { timeoutMs: 700 })) return true
    } catch {}
    await sleep(400)
  }
  return false
}

/** 面板「固定端口」：让 adbd 改为监听 3455，失败时说明原因。 */
function fixedPortHandler(scope, event) {
  const d = dict(event?.locale)
  return {
    pending: { label: d.pending.fixedPort, timeoutMs: 58_000 },
    result: async (signal) => {
      const adb = resolveAdb()
      if (!adb) return { toast: d.toast.noAdb }
      const devices = await adbDevices(adb, { signal })
      if (!devices.some((device) => device.state === 'device')) {
        return { toast: d.toast.fixedPortNoTransport }
      }
      rt.busy = 'tcpip'
      bump()
      invalidate()
      try {
        const tcpip = await adbTcpip(FIXED_PORT, { signal, timeoutMs: 12_000 })
        if (!tcpip.ok) return { toast: d.toast.fixedPortFail, patch: patchFor({ ok: false, reason: 'no-port' }, event?.locale) }
        saveState({ port: FIXED_PORT, addr: '' })
        const reborn = await waitForPort(FIXED_PORT, 12_000, signal)
        const result = reborn
          ? await connectOnce({ scan: false, install: false, waitMs: 12_000, signal })
          : { ok: false, reason: 'no-port' }
        return {
          toast: result.ok ? d.toast.fixedPort(FIXED_PORT) : d.toast.fixedPortTimeout,
          patch: patchFor(result, event?.locale),
        }
      } finally {
        rt.busy = null
        invalidate()
        bump()
      }
    },
  }
}

// ── 视图 ─────────────────────────────────────────────────────────────────

function stripTextFor(snap, locale) {
  const s = dict(locale).strip
  switch (snap.kind) {
    case 'connected': return s.connected(snap.port ?? '')
    case 'waiting-auth': return s.waiting
    case 'tcpip': return s.tcpip
    case 'connecting': return s.connecting
    case 'scanning': return s.scanning
    case 'installing': return s.installing
    case 'no-adb': return s.noadb
    default: return s.disconnected
  }
}

function stripToneFor(snap) {
  switch (snap.kind) {
    case 'connected': return 'good'
    case 'waiting-auth': return 'warn'
    case 'no-adb': return 'bad'
    case 'tcpip':
    case 'connecting':
    case 'scanning':
    case 'installing':
    case 'checking': return 'info'
    default: return 'muted'
  }
}

function stripDataFor(snap, locale) {
  return { text: stripTextFor(snap, locale), icon: 'terminal', tone: stripToneFor(snap) }
}

function statusTextFor(snap, locale) {
  const st = dict(locale).status
  switch (snap.kind) {
    case 'connected': return st.connected
    case 'waiting-auth': return st.waiting
    case 'tcpip': return st.tcpip
    case 'connecting': return st.connecting
    case 'scanning': return st.scanning
    case 'installing': return st.installing
    case 'no-adb': return st.noadb
    case 'checking': return st.checking
    default: return st.disconnected
  }
}

function noteFor(snap, locale) {
  const note = dict(locale).note
  switch (snap.kind) {
    case 'connected': return note.connected
    case 'waiting-auth': return note.waiting
    case 'tcpip': return note.tcpip
    case 'connecting': return note.connecting
    case 'scanning': return note.scanning
    case 'installing': return note.installing
    case 'no-adb': return note.noadb
    case 'checking': return note.checking
    default: return note.disconnected
  }
}

function panelDataFor(snap, locale) {
  const d = dict(locale)
  const pending = rt.pending
  return {
    note: noteFor(snap, locale),
    tone: stripToneFor(snap),
    status: statusTextFor(snap, locale),
    port: snap.port ? String(snap.port) : '—',
    device: snap.device || '—',
    adb: snap.adb || d.none,
    auto: snap.auto ? d.on : d.off,
    checked: snap.at ? clockOf(snap.at) : '—',
    pending: pending ? pending.command : '—',
    pendingNote: pending ? d.pendingNote(pending.command) : d.noPending,
    pendingTone: pending ? 'warn' : 'muted',
    recent: rt.recent.length > 0 ? rt.recent.map((item) => item.command).join('\n') : '—',
    lastError: snap.lastError || '—',
  }
}

function buildView(locale) {
  const d = dict(locale)
  return {
    type: 'stack',
    children: [
      { type: 'callout', text: { $: 'data.note' }, tone: { $: 'data.tone' } },
      { type: 'callout', text: { $: 'data.pendingNote' }, tone: { $: 'data.pendingTone' } },
      {
        type: 'keyValue',
        items: [
          [d.key.status, { $: 'data.status' }],
          [d.key.port, { $: 'data.port' }],
          [d.key.device, { $: 'data.device' }],
          [d.key.adb, { $: 'data.adb' }],
          [d.key.auto, { $: 'data.auto' }],
          [d.key.pending, { $: 'data.pending' }],
          [d.key.last, { $: 'data.lastError' }],
        ],
      },
      {
        type: 'actions',
        items: [
          { label: d.btn.connect, action: 'connect', icon: 'refresh', style: 'primary' },
          { label: d.btn.scan, action: 'scan', icon: 'search' },
          { label: d.btn.fixedPort, action: 'fixedPort', icon: 'pin' },
        ],
      },
      {
        type: 'actions',
        items: [
          { label: d.btn.approve, action: 'approve', icon: 'check' },
          { label: d.btn.deny, action: 'deny', icon: 'remove' },
        ],
      },
      {
        type: 'actions',
        items: [
          { label: d.btn.disconnect, action: 'disconnect', icon: 'link' },
          { label: d.btn.copy, action: 'copy', icon: 'copy' },
        ],
      },
      { type: 'text', text: d.hint, tone: 'muted' },
      { type: 'text', text: d.fixedHint, tone: 'muted' },
      { type: 'text', text: d.ai, tone: 'muted' },
      { type: 'text', text: { $: 'data.recent' }, tone: 'muted' },
    ],
  }
}

// ── 提示词注入 ───────────────────────────────────────────────────────

/**
 * 插件加载期间由 harness 展示的系统提示词段落。它规定 agent 使用 adb 的
 * 行为边界：先说再做、只读可直接查、系统级和写入操作必须先征得用户同意。
 */
function adbPromptText() {
  const snap = rt.lastKnown ?? rt.snapshot
  const connected = snap !== null && snap.kind === 'connected'
  const where = connected && snap.port ? `（127.0.0.1:${snap.port}）` : ''
  const head = connected
    ? `本机是 DSH Go 手机，ADB 通道已由「ADB 自动连接」插件连好${where}，bash 里可直接运行 adb 命令，也可以调用 adb 工具（参数更结构化）。`
    : '本机是 DSH Go 手机，装有「ADB 自动连接」插件（后台保持 adb 通道）；需要系统级操作时先用 adb devices 确认，不通再让用户到插件面板点「连接」。'
  return [
    head,
    '行为边界（本插件收紧后的约定，必须遵守）：',
    '1. 先说再做：每次使用 adb 前，先用一句话说明要做什么、为什么，再执行；不要静默执行。',
    '2. 只读查询可直接执行：devices、getprop、pm list、dumpsys、logcat、exec-out screencap -p、uiautomator dump、进程/电量/网络/温度查询。',
    '3. 系统级或写入操作必须先征得用户同意，同意后才执行：安装/卸载 APK、appops 改权限、settings put/delete、input 模拟点击输入、am 启动广播、强制停止、重启、删除或清空数据。',
    '4. 登录、支付、验证码、删除用户重要数据等敏感操作永远不通过 adb 执行，按原有规则先向用户确认。',
    '5. 被拦截时不要换参数绕过：这类命令会被工具层挡住并提示用户在插件面板点「允许一次」，用户放行后按原参数重试即可；删数据类红线命令没有放行途径。',
    '6. 固定端口和配对：不要自己执行 adb tcpip，让用户在插件面板点「固定端口」；Android 11+ 无线调试配对用 adb_pair 工具，仅在用户主动给出「无线调试」页的 IP、配对端口和 6 位配对码后调用，配对码不要复述、不要写进任何总结或文件，用完即弃。',
    '原因：手机上有账号和支付等敏感数据，自动批准可能让命令不经确认就执行，所以不能沿用「主动使用、不必先问」的做法。',
  ].join('\n')
}

// ── adb 工具 ───────────────────────────────────────────────────────────────

const TOOL_CLIP = 12_000
const TOOL_TIMEOUT_MS = 30_000
const TOOL_MAX_TIMEOUT_MS = 120_000

const ADB_TOOL_DESCRIPTION = [
  '在 DSH 手机的 ADB 通道上执行 adb 命令；插件会保持连接，连不上时先自动重连一次。',
  '先说再做：调用前先用一句话向用户说明这条命令做什么、为什么，不要静默调用。',
  '只读查询可直接执行：devices、getprop、pm list、dumpsys、logcat、exec-out screencap -p、uiautomator dump、进程/电量/网络/温度查询。',
  '系统级或写入操作必须先征得用户同意，同意后再调用：安装/卸载 APK、appops 改权限、settings put/delete、input tap/text、am 启动广播、强制停止、重启、rm/pm clear 等删除或清空数据。',
  '登录、支付、验证码、删除用户重要数据等敏感操作永远不通过 adb 执行。',
  '系统级/写入命令会被工具层拦下并返回「需要用户在插件面板点『允许一次』」：向用户说明后等其放行，再用完全相同的参数重试；不要换参数绕过。',
  '截图用 ["exec-out","screencap","-p"]：二进制会保存成 PNG 并返回文件路径，不再当文本输出。',
  '多设备时传 serial 参数（等价 adb -s <serial>）。',
  '不要自己执行 adb tcpip：固定端口由用户在插件面板点「固定端口」完成。',
  'Android 11+ 无线调试配对用 adb_pair 工具（见其说明），不要在 bash 里手动跑 adb pair，以免配对码落进日志。',
  'args 原样传给 adb，不经过 shell：例如 ["shell","pm","list","packages"]、["shell","appops","get","<包名>","REQUEST_INSTALL_PACKAGES"]、["devices","-l"]。',
].join('\n')

function clipToolText(text, max = TOOL_CLIP) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}\n…（已截断，原长 ${value.length} 字符）`
}

function adbFailure(reason) {
  switch (reason) {
    case 'no-adb': return '本机没有 adb 客户端：先运行 apt-get install -y adb，或打开插件面板点「连接」自动安装。'
    case 'no-port': return '没找到手机的 ADB 端口：让用户打开插件面板点「扫描端口」或确认 Stellar/无线调试的 TCP 已开启。'
    case 'unauthorized': return '手机还没授权调试：让用户到插件面板点「连接」，并在手机弹窗点「允许」。'
    default: return 'ADB 连接失败：让用户打开插件面板重试「连接」。'
  }
}

/** 面板里展示配对命令：只露 host:port，配对码一律遮蔽。 */
function pairCommandLabel(host, port) {
  const target = formatHostPort(host, port)
  return target ? `adb pair ${target} ••••••` : 'adb pair ••••••'
}

/** 记住最近几条 AI 发起的 adb 命令，面板里能看到。 */
function recordRecent(command) {
  rt.recent = [{ command, at: Date.now() }, ...rt.recent].slice(0, 5)
}

/**
 * 记下一条等待用户放行的命令，并刷新面板。
 * 返回给模型的拒绝文案：只读命令不受影响，红线命令明确没有放行途径。
 */
function blockedMessage(verdict, command) {
  if (verdict.tier === 'blocked') {
    return `这条命令被插件红线拦下，不能通过 adb 执行：${verdict.reason}。请改用其他方式，或先向用户确认。`
  }
  return `这条命令是系统级或写入操作，插件已拦下，需要用户在插件面板点「允许一次」：${command}。`
    + '向用户说明用途后，等用户放行，再用完全相同的参数重试。'
}

/** 保存截图等二进制输出：优先放到用户能打开的地方。 */
function saveBinary(buffer) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const name = `adb-${stamp}.png`
  const dirs = ['/sdcard/Download/DSH-Go', path.join(path.dirname(statePath), 'out')]
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, name)
      fs.writeFileSync(file, buffer)
      return { path: file, bytes: buffer.length }
    } catch {}
  }
  return null
}

/** 一份可直接注册的工具定义；写成工厂函数，注册失败时可以换个备用名重试。 */
function adbToolDefinition(toolName) {
  return {
    name: toolName,
    description: ADB_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: { type: 'string', description: '一句话说明这条 adb 命令要做什么（显示在界面上）。' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '原样传给 adb 的参数数组，不经过 shell。',
        },
        serial: { type: 'string', description: '可选：多设备时指定 adb 序列号（等价 adb -s <serial>）。' },
        timeoutMs: { type: 'number', description: '超时毫秒，默认 30000，最大 120000。' },
      },
      required: ['description', 'args'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'number' },
          command: { type: 'string' },
          device: { type: 'string' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
        required: ['exitCode', 'command', 'device', 'stdout', 'stderr'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `$ ${value.command}`,
          value.device ? `设备：${value.device}` : '',
          value.stdout.trimEnd(),
          value.stderr ? `[stderr] ${value.stderr.trimEnd()}` : '',
          `exit ${value.exitCode}`,
        ].filter(Boolean).join('\n'),
      }],
      presentationMeta: (_args, value) => ({
        'dsh-go/view': {
          type: 'stack',
          title: 'ADB',
          children: [
            {
              type: 'keyValue',
              items: [
                ['命令', value.command],
                ['退出码', String(value.exitCode)],
                ['设备', value.device || '—'],
              ],
            },
            { type: 'text', text: (value.stdout || value.stderr || '（无输出）').slice(0, 1500), tone: 'muted' },
          ],
        },
      }),
    },
    presentCall: (args) => ({ card: 'generic', title: 'adb', rawInput: args }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const adbArgs = Array.isArray(args.args) ? args.args.map((item) => String(item)) : []
      const serial = typeof args.serial === 'string' ? args.serial.trim() : ''
      const runArgs = serial ? ['-s', serial, ...adbArgs] : adbArgs
      const command = ['adb', ...runArgs].join(' ')
      if (adbArgs.length === 0) {
        return { exitCode: -1, command, device: '', stdout: '', stderr: 'args 不能为空。' }
      }
      const verdict = judge(adbArgs)
      recordRecent(command)
      if (verdict.tier === 'blocked') {
        return { exitCode: -1, command, device: '', stdout: '', stderr: blockedMessage(verdict, command) }
      }
      if (verdict.tier === 'confirm') {
        if (!hasGrant(verdict.key)) {
          rt.pending = { key: verdict.key, command, at: Date.now() }
          invalidate()
          bump()
          return { exitCode: -1, command, device: '', stdout: '', stderr: blockedMessage(verdict, command) }
        }
        consumeGrant(verdict.key)
      }
      const adb = resolveAdb()
      if (!adb) {
        return { exitCode: -1, command, device: '', stdout: '', stderr: adbFailure('no-adb') }
      }
      let snap = await snapshot({ ttl: 1000 })
      if (snap.kind !== 'connected') {
        const linked = await connectOnce({ scan: false, install: false, waitMs: 8000 })
        if (!linked.ok) {
          return { exitCode: -1, command, device: '', stdout: '', stderr: adbFailure(linked.reason) }
        }
        snap = await snapshot({ ttl: 0 })
      }
      const timeoutMs = Number.isFinite(args.timeoutMs)
        ? Math.min(TOOL_MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(args.timeoutMs)))
        : TOOL_TIMEOUT_MS
      // 截图这类命令输出的是二进制，按 Buffer 收，再落盘成文件。
      const binary = adbArgs.some((item) => item.toLowerCase() === 'screencap')
      const result = binary
        ? await run(adb, runArgs, { timeoutMs, signal: exec?.signal, encoding: 'buffer' })
        : await run(adb, runArgs, { timeoutMs, signal: exec?.signal })
      let stdout = ''
      if (binary && Buffer.isBuffer(result.stdout) && result.stdout.length > 0) {
        const saved = saveBinary(result.stdout)
        stdout = saved
          ? `截图已保存：${saved.path}（${saved.bytes} 字节）`
          : `截图输出 ${result.stdout.length} 字节，但保存失败，请检查存储权限。`
      } else {
        stdout = clipToolText(binary ? String(result.stdout) : result.stdout)
      }
      const stderrText = binary ? result.stderr.toString('utf8') : result.stderr
      const stderr = [
        result.error ? String(result.error.message ?? result.error) : '',
        result.killed ? '命令超时被终止。' : '',
        stderrText ? clipToolText(stderrText) : '',
      ].filter(Boolean).join('\n')
      return {
        exitCode: typeof result.code === 'number' ? result.code : -1,
        command,
        device: snap.device || snap.serial || '',
        stdout,
        stderr,
      }
    },
  }
}

const PAIR_TOOL_DESCRIPTION = [
  '配对 Android 11+ 的无线调试（TLS）。调用前先让用户打开 开发者选项 → 无线调试 →「使用配对码配对设备」；用户把手机显示的 IP、配对端口和 6 位配对码给你之后才能调用。',
  '只有在用户主动给出这三个值后才调用；配对码是敏感信息：不要在回复里复述、不要写进总结/文件，用完即弃。',
  '成功后会尝试用 adb mdns 发现 |_adb-tls-connect._tcp| 服务并自动 adb connect；找不到时返回提示，让用户读「无线调试」主页面的 IP:端口，用 connectPort 参数重试。',
  'Android 11 以下没有无线调试，不能用本工具；需要固定 adbd 端口请让用户点插件面板「固定端口」，不要用本工具。',
].join('\n')

function adbPairDefinition() {
  return {
    name: 'adb_pair',
    description: PAIR_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: { type: 'string', description: '手机「无线调试」页显示的 IP 地址。' },
        pairPort: { type: 'number', description: '配对端口（配对弹窗里显示的那个端口）。' },
        code: { type: 'string', pattern: '^[0-9]{6}$', description: '手机显示的 6 位配对码，只在本次调用使用，不保存。' },
        connectPort: { type: 'number', description: '可选：已知连接端口时直接传，跳过 mDNS 发现。' },
        timeoutMs: { type: 'number', description: '超时毫秒，默认 30000，最大 120000。' },
      },
      required: ['host', 'pairPort', 'code'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, target: { type: 'string' }, address: { type: 'string' }, detail: { type: 'string' } },
        required: ['ok', 'target', 'address', 'detail'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [value.ok ? '配对完成' : '配对未完成', value.address ? `连接地址：${value.address}` : '', value.detail].filter(Boolean).join('\n'),
      }],
      presentationMeta: (_args, value) => ({
        'dsh-go/view': {
          type: 'stack',
          title: '无线调试配对',
          children: [
            {
              type: 'keyValue',
              items: [['结果', value.ok ? '成功' : '失败'], ['目标', value.target || '—'], ['地址', value.address || '—']],
            },
            { type: 'text', text: value.detail.slice(0, 1500), tone: 'muted' },
          ],
        },
      }),
    },
    presentCall: () => ({ card: 'generic', title: 'adb pair', rawInput: { host: '…', pairPort: '…', code: '••••••' } }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const host = String(args.host ?? '').trim()
      const pairPort = Number(args.pairPort)
      const code = String(args.code ?? '').trim()
      const connectPort = Number(args.connectPort)
      if (!host || !Number.isInteger(pairPort) || pairPort <= 0 || pairPort > 65_535) {
        return { ok: false, target: '', address: '', detail: 'host 或配对端口无效：需要手机「无线调试」页显示的 IP 和配对端口。' }
      }
      if (!/^[0-9]{6}$/.test(code)) {
        return { ok: false, target: '', address: '', detail: '配对码应为手机显示的 6 位数字。' }
      }
      const grantKey = commandKey(['pair', host, pairPort, code])
      if (!hasGrant(grantKey)) {
        rt.pending = { key: grantKey, command: pairCommandLabel(host, pairPort), at: Date.now() }
        invalidate()
        bump()
        return {
          ok: false,
          target: '',
          address: '',
          detail: `无线调试配对是系统级操作，需要用户在插件面板点「允许一次」：${pairCommandLabel(host, pairPort)}。配对码不会显示；用户放行后再用相同参数重试。`,
        }
      }
      consumeGrant(grantKey)
      const adb = resolveAdb()
      if (!adb) return { ok: false, target: '', address: '', detail: '本机没有 adb 客户端：先安装 adb 或点面板「连接」自动安装。' }
      const timeoutMs = Number.isFinite(args.timeoutMs)
        ? Math.min(TOOL_MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(args.timeoutMs)))
        : 30_000
      const pair = await adbPair(host, pairPort, code, { timeoutMs, signal: exec?.signal })
      if (!pair.ok) {
        return { ok: false, target: pair.target, address: '', detail: `${pair.detail || '配对失败'}（检查 IP、配对端口、配对码，以及手机是否停在配对弹窗上）` }
      }
      let address = Number.isInteger(connectPort) && connectPort > 0 && connectPort < 65_536 ? formatHostPort(host, connectPort) : ''
      for (let attempt = 0; attempt < 3 && !address; attempt++) {
        const mdns = await adbMdns({ timeoutMs: 6_000, signal: exec?.signal })
        const service = mdns.services.find((item) => item.kind === 'connect' && item.host === host)
          ?? mdns.services.find((item) => item.kind === 'connect')
        if (service) address = service.address
        else if (attempt < 2) await sleep(1200)
      }
      if (!address) {
        return {
          ok: true,
          target: pair.target,
          address: '',
          detail: '配对成功，但没在 mDNS 里发现连接端口。请让用户读「无线调试」主页面上的 IP:端口，再用 connectPort 参数重试（或 adb connect <IP>:<端口>）。',
        }
      }
      const linked = await adbConnect(address, { timeoutMs: 12_000, signal: exec?.signal })
      if (linked.ok) {
        saveState({
          addr: address,
          port: portOf(address) ?? loadState().port,
          authorized: true,
          auto: true,
          lastAt: Date.now(),
          authWaitUntil: 0,
          lastError: '',
        })
        invalidate()
        return { ok: true, target: pair.target, address, detail: `配对并已连接：${address}（已记住地址，之后自动重连）` }
      }
      saveState({ addr: address, lastError: 'tls-connect-failed' })
      invalidate()
      return { ok: false, target: pair.target, address, detail: `配对成功，但 adb connect 没连上：${linked.detail || 'timeout'}` }
    },
  }
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

export function apply(ctx) {
  // 不依赖 dsh-go：任何挂载了 systemPrompt 的 harness 主机都能拿到这段指导；
  // 没有原生桥接时，插件只是没有原生界面而已。
  ctx.inject(['systemPrompt'], (scope) => {
    const bashOrder = scope.systemPrompt.getSectionOrder('TOOL_BASH')
    scope.systemPrompt.section({
      name: 'adb-link:prompt',
      order: Number.isFinite(bashOrder) ? bashOrder + 5 : 1005,
      interpolate: false,
      text: () => adbPromptText(),
    })
  })

  ctx.inject(['tools'], (scope) => {
    try {
      scope.tools.register(adbToolDefinition('adb'))
    } catch {
      // “adb”这个名字被其他插件占了；换个备用名继续提供这项能力。
      try { scope.tools.register(adbToolDefinition('adb_shell')) } catch {}
    }
    try { scope.tools.register(adbPairDefinition()) } catch {}
    // 工具层闸门：确认档、红线档在宿主调度前就拒绝，不依赖提示词自觉。
    // 测试宿主可能没有 guard 接口，所以先做能力检测。
    if (typeof scope.tools.guard === 'function') {
      try {
        scope.tools.guard((exec) => {
          const toolName = exec?.name
          if (toolName === 'adb_pair') {
            const host = String(exec?.arguments?.host ?? '').trim()
            const pairPort = Number(exec?.arguments?.pairPort)
            const code = String(exec?.arguments?.code ?? '').trim()
            const key = commandKey(['pair', host, pairPort, code])
            if (hasGrant(key)) return undefined
            const command = pairCommandLabel(host, pairPort)
            rt.pending = { key, command, at: Date.now() }
            invalidate()
            bump()
            return `无线调试配对是系统级操作，插件已拦下：${command}。配对码不会显示。向用户说明用途后，等用户在插件面板点「允许一次」，再用完全相同的参数重试。`
          }
          if (toolName !== 'adb' && toolName !== 'adb_shell') return undefined
          const args = Array.isArray(exec?.arguments?.args) ? exec.arguments.args : []
          const verdict = judge(args)
          if (verdict.tier === 'blocked') return blockedMessage(verdict, ['adb', ...args].join(' '))
          if (verdict.tier !== 'confirm') return undefined
          if (hasGrant(verdict.key)) return undefined
          rt.pending = { key: verdict.key, command: ['adb', ...args].join(' '), at: Date.now() }
          invalidate()
          bump()
          return blockedMessage(verdict, ['adb', ...args].join(' '))
        })
      } catch {}
    }
  })

  ctx.inject(['dshGo'], (ctx) => {
    const startData = (emit, caps, isPanel) => {
      const locale = caps?.locale ?? ''
      let alive = true
      const push = async () => {
        try {
          const snap = await snapshot()
          if (!alive) return
          remember(snap)
          if (snap.kind === 'disconnected') {
            // adb server 挂掉时它自己不会恢复：低频 start-server 一次，再尝试重连。
            if (resolveAdb() && Date.now() - rt.lastServerAt > 300_000) {
              rt.lastServerAt = Date.now()
              adbStartServer({ timeoutMs: 8_000 }).then(() => maybeAutoConnect()).catch(() => {})
            } else {
              maybeAutoConnect()
            }
          }
          emit(isPanel ? panelDataFor(snap, locale) : stripDataFor(snap, locale))
        } catch {
          if (!alive) return
          emit(isPanel
            ? {
              note: dict(locale).note.disconnected, tone: 'muted', status: dict(locale).status.disconnected,
              port: '—', device: '—', adb: '—', auto: '—', checked: '—',
              pending: '—', pendingNote: dict(locale).noPending, pendingTone: 'muted', recent: '—', lastError: '—',
            }
            : { text: dict(locale).strip.disconnected, icon: 'terminal', tone: 'muted' })
        }
      }
      if (isPanel) {
        emit({
          note: dict(locale).note.checking,
          tone: 'info',
          status: dict(locale).status.checking,
          port: loadState().port ? String(loadState().port) : '—',
          device: '—',
          adb: resolveAdb() || dict(locale).none,
          auto: loadState().auto === false ? dict(locale).off : dict(locale).on,
          checked: clockOf(Date.now()),
          pending: '—',
          pendingNote: dict(locale).noPending,
          pendingTone: 'muted',
          recent: '—',
          lastError: '—',
        })
      }
      push()
      const timer = setInterval(push, isPanel ? PANEL_POLL_MS : STRIP_POLL_MS)
      timer.unref?.()
      const off = subscribeLive(push)
      maybeAutoConnect()
      return () => {
        alive = false
        clearInterval(timer)
        off()
      }
    }

    // 引擎一启动就尽早恢复连接，不用等界面来看。
    maybeAutoConnect()

    // 输入框上方的状态条；点它打开面板。
    ctx.dshGo.strip('adb-state', (scope, emit, caps) => startData(emit, caps, false))

    ctx.dshGo.panel('adb', {
      view: (scope, caps) => buildView(caps?.locale),
      data: (scope, emit, caps) => startData(emit, caps, true),
      actions: {
        connect: connectHandler,
        scan: scanHandler,
        fixedPort: fixedPortHandler,
        disconnect: disconnectHandler,
        copy: copyHandler,
        approve: approveHandler,
        deny: denyHandler,
      },
    })
  })
}

/** 仅供本地测试跑器使用。 */
export const __test = {
  snapshot,
  connectOnce,
  discoverPort,
  statePath,
  buildView,
  panelDataFor,
  stripDataFor,
  adbPromptText,
  pickDevice,
  portOf,
  clipToolText,
  saveBinary,
  adbToolDefinition,
  adbPairDefinition,
  runtimeState: () => ({ pending: rt.pending, recent: rt.recent }),
  resetRuntime() {
    rt.pending = null
    rt.recent = []
    rt.snapshot = null
    rt.snapshotAt = 0
    rt.snapshotInflight = null
  },
}
