// 把 adb 参数分成三档：
//   read    —— 只读查询，AI 可以直接执行；
//   confirm —— 系统级或写入操作，需要用户在插件面板点「允许一次」；
//   blocked —— 删除数据等红线，永远拒绝。
// 纯函数，不碰进程和文件，方便单测。
import { createHash } from 'node:crypto'

/** 这些 shell 命令会删除或覆盖数据，任何情况下都不放行。 */
function blockedShell(words) {
  const first = words[0] ?? ''
  const second = words[1] ?? ''
  if (first === 'rm') return '删除文件（rm）属于红线操作'
  if (first === 'pm' && second === 'clear') return '清空应用数据（pm clear）属于红线操作'
  if (first === 'format' || first === 'mkfs' || first.startsWith('mkfs.')) return '格式化分区属于红线操作'
  if (first === 'dd' && words.some((word) => /^of=\/dev\/block/.test(word))) return '直接写块设备（dd of=/dev/block）属于红线操作'
  return null
}

/** `adb` 子命令层面的只读白名单。 */
const READ_ADB = new Set(['devices', 'getprop', 'get-state', 'version'])

/** 建立或恢复调试连接本身属于连接操作，不修改手机数据，不需要额外放行。 */
const LINK_ADB = new Set(['connect', 'disconnect', 'pair', 'mdns', 'start-server', 'kill-server'])

/** shell 里可以直接运行的只读命令（第一个词）。 */
const READ_SHELL = new Set([
  'getprop', 'dumpsys', 'cat', 'ls', 'id', 'ps', 'df', 'du', 'free', 'uptime',
  'date', 'uname', 'whoami', 'which', 'ifconfig', 'netstat', 'ss', 'getenforce',
  'getevent', 'logcat', 'screencap',
])

/** shell 里成对出现的只读子命令（第一个词 → 允许的第二个词）。 */
const READ_PAIRS = new Map([
  ['pm', new Set(['list', 'path', 'dump'])],
  ['settings', new Set(['get'])],
  ['appops', new Set(['get'])],
  ['wm', new Set(['size', 'density'])],
  ['cmd', new Set(['package'])],
])

function shellWords(tokens) {
  return tokens.flatMap((token) => String(token).split(/\s+/)).filter(Boolean)
}

function isReadOnlyShell(words) {
  const first = words[0] ?? ''
  if (first === 'ip') return words[1] === 'addr' || words[1] === 'route'
  // -c/--clear 清日志；-f/--file 写手机存储；-r/-n 是配合 -f 的轮转参数。
  if (first === 'logcat') {
    return !words.some((word) => ['-c', '--clear', '-f', '--file', '-r', '-n'].includes(word))
  }
  if (first === 'top') return !words.includes('-o')
  if (READ_PAIRS.has(first)) return READ_PAIRS.get(first).has(words[1] ?? '')
  return READ_SHELL.has(first)
}

/**
 * 判断一次 adb 调用属于哪一档。
 * @param {string[]} args 原样传给 adb 的参数数组。
 * @returns {{ tier: 'read' | 'confirm' | 'blocked', key: string, reason: string }}
 */
export function judge(args) {
  const list = Array.isArray(args) ? args.map((item) => String(item)) : []
  const key = commandKey(list)
  // 跳过 -s/-H/-P 这类全局参数（它们带一个值），再看真正的子命令。
  let index = 0
  while (index < list.length && ['-s', '-H', '-P'].includes(list[index])) index += 2
  const lower = list.slice(index).map((item) => item.toLowerCase())
  const first = lower[0] ?? ''
  // 连接、断开、无线调试配对都只是建立/断开调试通道，不改手机数据。
  if (LINK_ADB.has(first)) return { tier: 'read', key, reason: '' }
  if (first === 'shell') {
    const words = shellWords(lower.slice(1))
    const blocked = blockedShell(words)
    if (blocked) return { tier: 'blocked', key, reason: blocked }
    if (isReadOnlyShell(words)) return { tier: 'read', key, reason: '' }
    return { tier: 'confirm', key, reason: '' }
  }
  if (first === 'sideload') return { tier: 'blocked', key, reason: '侧载刷机（sideload）属于红线操作' }
  if (first === 'exec-out' && lower[1] === 'screencap') return { tier: 'read', key, reason: '' }
  if (READ_ADB.has(first)) return { tier: 'read', key, reason: '' }
  return { tier: 'confirm', key, reason: '' }
}

/**
 * 一次 adb 调用的稳定标识：参数相同则 key 相同，供一次性授权和面板去重使用。
 * @param {string[]} args
 * @returns {string}
 */
export function commandKey(args) {
  const list = Array.isArray(args) ? args.map((item) => String(item)) : []
  return createHash('sha1').update(list.join('\u0000')).digest('hex').slice(0, 16)
}
