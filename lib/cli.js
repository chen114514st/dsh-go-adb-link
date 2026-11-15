// 调用这个 Ubuntu rootfs 里的 adb 客户端。
//
// 客户端就是个普通程序：PATH 里任何 `adb` 都能用；App 运行时升级把它删掉时，
// 插件可以用 apt 装回来（见 installAdb）。所有命令都和本机其他程序共用
// 127.0.0.1:5037 上的 adb server，所以插件连上之后，DSH bash 里直接写
// `adb shell` 也能用。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CANDIDATES = [
  '/usr/bin/adb',
  '/usr/local/bin/adb',
  '/usr/lib/android-sdk/platform-tools/adb',
  '/opt/android-sdk/platform-tools/adb',
  '/root/bin/adb',
  '/sdcard/Android/data/io.github.ccch1mneyyy.dsh_app/files/adb',
]

let cached = { at: 0, path: null }

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findOnPath(name) {
  for (const dir of String(process.env.PATH ?? '').split(':').filter(Boolean)) {
    const file = path.join(dir, name)
    if (executable(file)) return file
  }
  return null
}

/** 可用的 adb 客户端绝对路径，找不到时为 null。缓存 10 秒。 */
export function resolveAdb() {
  const now = Date.now()
  if (now - cached.at < 10_000) return cached.path
  let found = null
  for (const file of [process.env.ADB_PATH, process.env.ADB].filter(Boolean)) {
    if (executable(String(file))) {
      found = String(file)
      break
    }
  }
  if (!found) for (const file of CANDIDATES) if (executable(file)) { found = file; break }
  if (!found) found = findOnPath('adb')
  cached = { at: now, path: found }
  return found
}

/** 清掉缓存的查找结果（安装或卸载客户端之后调用）。 */
export function resetAdbCache() {
  cached = { at: 0, path: null }
}

/**
 * 运行一个程序并收集 stdout/stderr；非零退出码也不会抛异常。
 * `encoding: 'buffer'` 时 stdout/stderr 直接给 Buffer（截图这类二进制输出用），
 * 默认按 utf8 解码成字符串。
 */
export function run(file, args, { timeoutMs = 15_000, signal, env, encoding = 'utf8' } = {}) {
  return new Promise((resolve) => {
    let child
    let timer
    let settled = false
    const binary = encoding === 'buffer'
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      const stdout = Buffer.concat(outChunks)
      const stderr = Buffer.concat(errChunks)
      resolve(binary ? { ...result, stdout, stderr } : {
        ...result,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      })
    }
    const onAbort = () => { try { child?.kill('SIGKILL') } catch {} }
    const outChunks = []
    const errChunks = []
    try {
      child = spawn(file, args, {
        env: { ...process.env, HOME: process.env.HOME || '/root', ...(env ?? {}) },
        cwd: process.env.HOME || '/root',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: null, stdout: binary ? Buffer.alloc(0) : '', stderr: binary ? Buffer.alloc(0) : '', error })
      return
    }
    child.stdout?.on('data', (chunk) => { outChunks.push(chunk) })
    child.stderr?.on('data', (chunk) => { errChunks.push(chunk) })
    child.once('error', (error) => finish({ code: null, error }))
    child.once('close', (code, killedBy) => finish({ code, killed: killedBy ?? null }))
    timer = setTimeout(() => { onAbort() }, timeoutMs)
    timer.unref?.()
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener?.('abort', onAbort, { once: true })
    }
  })
}

/** 把 `adb devices -l` 的解析结果建成 [{ serial, state, model?, device? }]。 */
export function parseDevices(text) {
  const out = []
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('List of devices') || line.startsWith('*')) continue
    const parts = line.split(/\s+/)
    const serial = parts[0]
    const state = parts[1]
    if (!serial || !state) continue
    const extra = {}
    for (const pair of parts.slice(2)) {
      const at = pair.indexOf(':')
      if (at > 0) extra[pair.slice(0, at)] = pair.slice(at + 1)
    }
    out.push({ serial, state, ...extra })
  }
  return out
}

/** adb server 当前已知的设备（没有客户端或没有 server 时为空）。 */
export async function adbDevices(adbPath = resolveAdb(), options = {}) {
  if (!adbPath) return []
  const result = await run(adbPath, ['devices', '-l'], { timeoutMs: 10_000, ...options })
  if (result.error || (typeof result.code === 'number' && result.code !== 0 && result.stdout === '')) return []
  return parseDevices(result.stdout)
}

/** 把 host 和端口拼成 adb 能接受的地址（IPv6 加方括号）。 */
export function formatHostPort(host, port) {
  const text = String(host ?? '').trim()
  if (!text) return ''
  if (text.startsWith('[')) return `${text}:${port}`
  if (text.includes(':')) return `[${text}]:${port}`
  return `${text}:${port}`
}

/**
 * 执行 `adb connect`；返回 { ok, detail }。
 * `port` 可以是端口号（默认连 127.0.0.1），也可以是 `host:port` 地址
 * （Android 11+ 无线调试的 TLS 端口不监听在回环地址上，必须带主机名）。
 */
export async function adbConnect(port, options = {}) {
  const adbPath = resolveAdb()
  if (!adbPath) return { ok: false, detail: 'no-adb' }
  if (port === null || port === undefined || port === '') return { ok: false, detail: 'no-target' }
  const address = typeof port === 'string' && port.includes(':') ? port : `127.0.0.1:${port}`
  const result = await run(adbPath, ['connect', address], { timeoutMs: 12_000, ...options })
  const text = `${result.stdout}\n${result.stderr}`.trim()
  return { ok: !result.error && text.toLowerCase().includes('connected'), detail: text }
}

/** 对目标端点和裸 127.0.0.1 各执行一次 `adb disconnect`；尽力而为。 */
export async function adbDisconnect(port, options = {}) {
  const adbPath = resolveAdb()
  if (!adbPath) return { ok: false }
  const args = port ? ['disconnect', `127.0.0.1:${port}`] : ['disconnect']
  const result = await run(adbPath, args, { timeoutMs: 8_000, ...options })
  return { ok: !result.error, detail: `${result.stdout}`.trim() }
}

/**
 * 让 adbd 固定监听 TCP 端口：`adb tcpip <port>`。
 * 注意：这条命令要有现成传输（USB 或已连上的 TCP）才能下发，执行后 adbd
 * 会重启一次，端口要等一会儿才重新监听；重启手机后失效。
 */
export async function adbTcpip(port, options = {}) {
  const adbPath = resolveAdb()
  if (!adbPath) return { ok: false, detail: 'no-adb' }
  const result = await run(adbPath, ['tcpip', String(port)], { timeoutMs: 12_000, ...options })
  const text = `${result.stdout}\n${result.stderr}`.trim()
  return { ok: !result.error && result.code === 0, detail: text }
}

/**
 * Android 11+ 无线调试配对：`adb pair <host>:<port> <code>`。
 * 配对码只交给 adb 这一次，不写日志、不进 state、不回显。
 */
export async function adbPair(host, port, code, options = {}) {
  const adbPath = resolveAdb()
  if (!adbPath) return { ok: false, detail: 'no-adb', target: '' }
  const target = formatHostPort(host, port)
  const result = await run(adbPath, ['pair', target, String(code ?? '')], { timeoutMs: 20_000, ...options })
  const text = `${result.stdout}\n${result.stderr}`.trim()
  const detail = code ? text.split(String(code)).join('••••••') : text
  return { ok: !result.error && /successfully paired/i.test(text), detail, target }
}

/** 解析 `adb mdns services` 的输出，找出无线调试的配对/连接服务。 */
export function parseMdns(text) {
  const out = []
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line || !line.includes('_adb')) continue
    const parts = line.split(/\s+/)
    const service = parts.find((part) => part.startsWith('_adb')) ?? ''
    const kind = service.includes('_adb-tls-connect') ? 'connect'
      : service.includes('_adb-tls-pairing') ? 'pairing'
        : ''
    if (kind !== 'connect' && kind !== 'pairing') continue
    const address = [...parts].reverse().find((part) => /:\d+$/.test(part)) ?? ''
    const at = address.lastIndexOf(':')
    const host = at > 0 ? address.slice(0, at) : ''
    const port = at > 0 ? Number(address.slice(at + 1)) : NaN
    if (!host || !Number.isInteger(port) || port <= 0) continue
    out.push({ kind, name: parts[0] ?? '', host, port, address })
  }
  return out
}

/** 列出 mDNS 上广播的 adb 服务（需要 adb 40+ 且设备与手机在同一网络）。 */
export async function adbMdns(options = {}) {
  const adbPath = resolveAdb()
  if (!adbPath) return { ok: false, services: [], detail: 'no-adb' }
  const result = await run(adbPath, ['mdns', 'services'], { timeoutMs: 8_000, ...options })
  const text = `${result.stdout}\n${result.stderr}`.trim()
  return { ok: !result.error && result.code === 0, services: parseMdns(result.stdout), detail: text }
}

export async function adbStartServer(options = {}) {
  const adbPath = resolveAdb()
  if (!adbPath) return { ok: false, detail: 'no-adb' }
  const result = await run(adbPath, ['start-server'], { timeoutMs: 15_000, ...options })
  return { ok: !result.error && result.code === 0, detail: `${result.stderr}`.trim() }
}

/**
 * 运行时升级把 adb 客户端删掉时，用 apt 把发行版的 adb 装回来。
 * 返回 { ok, detail, path }。
 */
export async function installAdb({ signal, timeoutMs = 55_000 } = {}) {
  const apt = ['/usr/bin/apt-get', '/bin/apt-get'].find(executable) ?? findOnPath('apt-get')
  if (!apt) return { ok: false, detail: 'no-apt' }
  const result = await run(apt, ['install', '-y', '-qq', 'adb'], {
    timeoutMs,
    signal,
    env: { DEBIAN_FRONTEND: 'noninteractive' },
  })
  resetAdbCache()
  const path = resolveAdb()
  const tail = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' | ')
  return { ok: path !== null, path, detail: tail.slice(0, 400) }
}
