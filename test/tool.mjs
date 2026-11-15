// 检查面向 agent 的 adb 工具：注册、参数、渲染、以及工具层的风险拦截。
// 离线可跑：真正的 adb 只在本机已连上 ADB 通道时才验证。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import './hooks.mjs'

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const kitCandidates = [
  process.env.DSH_GO_PLUGIN_KIT,
  path.join(process.env.HOME || '/root', '.dsh', 'skills', 'dsh-go-plugin', 'kit', 'lib', 'testing.js'),
  path.join(process.env.DSH_HOME || '/root/.dsh', 'skills', 'dsh-go-plugin', 'kit', 'lib', 'testing.js'),
].filter(Boolean)
const kit = kitCandidates.find((file) => fs.existsSync(file))
if (!kit) {
  console.log('跳过：本机没有 dsh-go 插件工具包（kit），跳过依赖它的检查 →', kitCandidates.join(', '))
  process.exit(0)
}
const { createTestHost } = await import(pathToFileURL(kit).href)

const sections = []
const registered = []
let guardFn = null
const systemPrompt = {
  section(s) { sections.push(s); return () => {} },
  getSectionOrder(name) { return { TOOL_BASH: 1000 }[name] },
}
const tools = {
  register(def) { registered.push(def); return () => {} },
  guard(fn) { guardFn = fn; return () => {} },
}

const host = createTestHost({ dir, services: { systemPrompt, tools } })
const mod = await import(path.join(dir, 'lib', 'index.js'))
mod.apply(host.ctx)

const { judge, commandKey } = await import(path.join(dir, 'lib', 'risk.js'))
const { allowOnce, clearGrants } = await import(path.join(dir, 'lib', 'grants.js'))

let failures = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}

const def = registered.find((entry) => entry.name === 'adb') || registered.find((entry) => entry.name === 'adb_shell')
check(def !== undefined, 'adb tool registered', registered.map((entry) => entry.name).join(', ') || '(none)')
if (def === undefined) process.exit(1)
check(typeof def.description === 'string' && def.description.includes('征得用户同意'), 'description requires consent for system-level adb')
check(def.description.includes('允许一次'), 'description explains the panel approval')
check(def.parameters?.type === 'object', 'parameters are a JSON schema object')
check(def.parameters?.properties?.serial !== undefined, 'parameters expose the serial field')
check(def.output?.render instanceof Function, 'render is present')
check(def.output?.presentationMeta instanceof Function, 'presentationMeta is present')

const fake = { exitCode: 0, stdout: 'ok\n', stderr: '', command: 'adb shell echo ok' }
const rendered = def.output.render({}, fake)
check(rendered?.[0]?.type === 'text' && rendered[0].text.includes('ok'), 'render produces text content')
const meta = def.output.presentationMeta({}, fake)
check(meta?.['dsh-go/view']?.type === 'stack', 'presentationMeta carries a dsh-go view')

const empty = await def.execute({ description: 'noop', args: [] }, {})
check(empty.exitCode === -1 && empty.stderr.length > 0, 'empty args fail politely', JSON.stringify(empty.stderr))

const blocked = await def.execute({ description: 'wipe data', args: ['shell', 'rm', '-rf', '/sdcard/a'] }, {})
check(blocked.exitCode === -1 && blocked.stderr.length > 0, 'blocked commands are refused', JSON.stringify(blocked.stderr).slice(0, 120))

mod.__test.resetRuntime()
const needsConsent = await def.execute({ description: 'install', args: ['install', '/sdcard/x.apk'] }, {})
check(needsConsent.exitCode === -1 && needsConsent.stderr.length > 0, 'confirm-tier commands need consent')
check(mod.__test.runtimeState().pending?.key === commandKey(['install', '/sdcard/x.apk']), 'pending command is recorded for the panel')

if (guardFn) {
  const guard = guardFn
  check(typeof guard === 'function', 'tool-layer guard is registered')
  const verdictBlocked = guard({ name: 'adb', arguments: { args: ['shell', 'pm', 'clear', 'com.x'] } })
  check(typeof verdictBlocked === 'string' && verdictBlocked.length > 0, 'guard refuses blocked commands', JSON.stringify(verdictBlocked).slice(0, 100))
  const verdictConfirm = guard({ name: 'adb', arguments: { args: ['install', '/sdcard/x.apk'] } })
  check(typeof verdictConfirm === 'string' && verdictConfirm.includes('允许一次'), 'guard asks for the panel approval', JSON.stringify(verdictConfirm).slice(0, 100))
  const key = commandKey(['install', '/sdcard/x.apk'])
  allowOnce(key)
  check(guard({ name: 'adb', arguments: { args: ['install', '/sdcard/x.apk'] } }) === undefined, 'guard passes after a one-time approval')
  clearGrants()
  check(guard({ name: 'adb', arguments: { args: ['devices'] } }) === undefined, 'read-only commands pass the guard')
} else {
  console.log('skip tool-layer guard（测试宿主没有 tools.guard）')
}

// 无线调试配对工具：注册、参数、非法输入拒绝（不连真实网络）。
const pairDef = registered.find((entry) => entry.name === 'adb_pair')
check(pairDef !== undefined, 'adb_pair tool registered', registered.map((entry) => entry.name).join(', '))
if (pairDef) {
  check(pairDef.parameters?.properties?.host !== undefined, 'adb_pair exposes host')
  check(pairDef.parameters?.properties?.code?.pattern === '^[0-9]{6}$', 'adb_pair requires a 6-digit code')
  check(pairDef.parameters?.required?.includes('pairPort'), 'adb_pair requires pairPort')
  check(pairDef.output?.render instanceof Function, 'adb_pair render is present')
  check(typeof pairDef.presentCall === 'function' && JSON.stringify(pairDef.presentCall()).includes('••••••'), 'adb_pair hides the code in the call card')
  const badCode = await pairDef.execute({ host: '192.168.1.5', pairPort: 39235, code: '12ab' }, {})
  check(badCode.ok === false && badCode.detail.includes('6 位'), 'adb_pair rejects a bad code', JSON.stringify(badCode.detail))
  const badHost = await pairDef.execute({ host: '', pairPort: 39235, code: '123456' }, {})
  check(badHost.ok === false && badHost.detail.length > 0, 'adb_pair rejects a missing host')
  mod.__test.resetRuntime()
  if (guardFn) {
    const pairArgs = { name: 'adb_pair', arguments: { host: '192.168.1.5', pairPort: 39235, code: '123456' } }
    check(guardFn(pairArgs) === undefined, 'guard lets adb_pair through：连接与配对不需要放行')
    check(mod.__test.runtimeState().pending === null, 'pairing no longer creates a pending command')
    const connectArgs = { name: 'adb', arguments: { args: ['connect', '127.0.0.1:3455'] } }
    check(guardFn(connectArgs) === undefined, 'guard lets adb connect through')
  }
}

// 真实 adb 只在链路可用时验证，失败就跳过，不让离线机器误报。
const probe = await mod.__test.connectOnce({ scan: false, install: false, waitMs: 4_000 })
if (probe.ok) {
  const result = await def.execute(
    { description: 'echo through adb', args: ['shell', 'echo', 'adb-tool-ok'] },
    { signal: new AbortController().signal },
  )
  check(result.exitCode === 0, 'adb shell echo exit code', JSON.stringify(result.exitCode))
  check(result.stdout.includes('adb-tool-ok'), 'stdout carries the command result', JSON.stringify(result.stdout))
} else {
  console.log(`skip live adb checks（${probe.reason ?? 'no link'}）`)
}

host.dispose?.()
console.log(failures === 0 ? '\nall tool checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
