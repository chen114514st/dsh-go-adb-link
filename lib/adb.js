// 纯 Node 实现的 ADB 发现。
//
// 当 Shizuku 一类的管理器（Stellar）或 `adb tcpip <端口>` 打开 TCP 调试后，
// 手机就会通过 TCP 暴露 adbd。找这个端口不需要 adb 二进制：向端口发起 ADB
// 握手（CNXN），真正的 adbd 会回 CNXN（已配对）或 AUTH（需要密钥），
// 其他服务则没有任何应答。
import net from 'node:net'
import zlib from 'node:zlib'

const CNXN = 0x4e584e43
const AUTH = 0x48545541
const VERSION = 0x01000000 // 协议版本 1.0.0
const MAX_PAYLOAD = 256 * 1024

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function cnxnPacket() {
  const payload = Buffer.from('host::\0', 'latin1')
  const head = Buffer.alloc(24)
  head.writeUInt32LE(CNXN, 0)
  head.writeUInt32LE(VERSION, 4)
  head.writeUInt32LE(MAX_PAYLOAD, 8)
  head.writeUInt32LE(payload.length, 12)
  head.writeUInt32LE(crc32(payload), 16)
  head.writeUInt32LE((CNXN ^ 0xffffffff) >>> 0, 20)
  return Buffer.concat([head, payload])
}

/**
 * 当 `host` 上的 `port` 能回应 ADB 握手时返回 true。
 * 非 adbd 的服务（HTTP 服务器、TLS 端点、adb 自己的 server socket）要么直接
 * 关闭连接，要么超时，所以一次探测开销很小。
 */
export function probeAdb(port, { host = '127.0.0.1', timeoutMs = 450 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let socket
    const done = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket?.destroy() } catch {}
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    timer.unref?.()
    try {
      socket = net.connect({ host, port })
    } catch {
      done(false)
      return
    }
    socket.unref?.()
    socket.setNoDelay?.(true)
    socket.once('connect', () => {
      // TCP 自连：内核把目标端口本身选作源端口时（扫描临时端口段时很常见），
      // socket 会连到自己，把我们发出去的包原样回声回来。这不是 adbd。
      if (socket.localPort === port) return done(false)
      try { socket.write(cnxnPacket()) } catch { done(false) }
    })
    socket.once('data', (chunk) => {
      if (chunk.length < 4) return
      const cmd = chunk.readUInt32LE(0)
      // 真正的 adbd 会回 AUTH，或者回带 "device::" banner 的 CNXN。我们自己发
      // 的 CNXN 带的是 "host::"；收到同样的 banner 说明是自连回声。
      if (cmd === CNXN) {
        const banner = chunk.length >= 30 ? chunk.subarray(24, 30).toString('latin1') : ''
        return done(banner !== 'host::')
      }
      done(cmd === AUTH)
    })
    socket.once('error', () => done(false))
    socket.once('close', () => done(false))
  })
}

/**
 * 先探测 `candidatePorts`，再扫描 `[start, end]`，直到有 adbd 应答。
 * 返回找到的端口（通常正好一个）。`signal` 可以干净地中止。
 */
export async function findAdbPorts({
  candidatePorts = [],
  start = 1,
  end = 65535,
  concurrency = 400,
  timeoutMs = 280,
  exclude = [],
  signal,
} = {}) {
  const blocked = new Set(exclude)
  const candidates = [...new Set(candidatePorts)].filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535 && !blocked.has(p))
  for (const port of candidates) {
    if (signal?.aborted) return []
    if (await probeAdb(port, { timeoutMs: Math.max(600, timeoutMs * 2) })) return [port]
  }

  const found = []
  let next = Math.max(1, start)
  const stop = () => signal?.aborted === true || found.length > 0
  const worker = async () => {
    while (!stop()) {
      const port = next++
      if (port > end) return
      if (blocked.has(port)) continue
      if (await probeAdb(port, { timeoutMs })) found.push(port)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(800, concurrency)) }, worker))
  return found.sort((a, b) => a - b)
}
