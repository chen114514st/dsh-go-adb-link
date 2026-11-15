// 插件在引擎重启之间记住的内容：能用的端口，以及用户是否已在手机上授权过
// adb 密钥。把它放在 DSH_HOME 下（而不是包内），发布和重装插件就不会带上
// 运行时数据，这些记忆也能在引擎重置和插件升级后保留。
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.DSH_HOME?.trim() || path.join(process.env.HOME || '/root', '.dsh')
const FILE = path.join(HOME, 'dsh-go', 'adb-link', 'state.json')

const DEFAULTS = Object.freeze({
  v: 1,
  port: null,
  authorized: false,
  auto: true,
  lastAt: 0,
  authWaitUntil: 0,
  lastError: '',
  addr: '',
})

let current = null

function clean(value) {
  const out = { ...DEFAULTS }
  if (value === null || typeof value !== 'object') return out
  if (Number.isInteger(value.port) && value.port > 0 && value.port < 65536) out.port = value.port
  if (typeof value.authorized === 'boolean') out.authorized = value.authorized
  if (typeof value.auto === 'boolean') out.auto = value.auto
  if (Number.isFinite(value.lastAt)) out.lastAt = value.lastAt
  if (Number.isFinite(value.authWaitUntil)) out.authWaitUntil = value.authWaitUntil
  if (typeof value.lastError === 'string') out.lastError = value.lastError.slice(0, 200)
  if (typeof value.addr === 'string' && /^[^\s:]+:[0-9]{1,5}$/.test(value.addr.trim())) out.addr = value.addr.trim()
  return out
}

/** 已持久化的状态（内存中有缓存）。 */
export function loadState() {
  if (current) return current
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    raw = null
  }
  current = clean(raw)
  return current
}

/** 把 `patch` 合并进已持久化的状态并写回（尽力而为）。 */
export function saveState(patch = {}) {
  const next = { ...loadState(), ...patch, v: 1 }
  current = clean(next)
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    const tmp = `${FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, FILE)
  } catch {
    try { fs.rmSync(`${FILE}.${process.pid}.tmp`, { force: true }) } catch {}
  }
  return current
}

export const statePath = FILE

/** 仅供单测：清掉内存缓存，让下次 loadState 重新读盘。 */
export function resetStateCache() {
  current = null
}
