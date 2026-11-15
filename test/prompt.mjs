// 检查 adb 行为边界提示词段落：它必须注册到 systemPrompt 服务，
// 并写明先说再做、只读免确认、系统级/写入先征得同意、红线不可放行。
import './hooks.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const kitCandidates = [
  process.env.DSH_GO_PLUGIN_KIT,
  path.join(process.env.HOME || '/root', '.dsh', 'skills', 'dsh-go-plugin', 'kit', 'lib', 'testing.js'),
  path.join(process.env.DSH_HOME || '/root/.dsh', 'skills', 'dsh-go-plugin', 'kit', 'lib', 'testing.js'),
].filter(Boolean)
const kit = kitCandidates.find((file) => fs.existsSync(file))
if (!kit) { console.error('missing kit, tried:', kitCandidates.join(', ')); process.exit(2) }
const { createTestHost } = await import(pathToFileURL(kit).href)

const sections = []
const systemPrompt = {
  section(s) { sections.push(s); return () => {} },
  getSectionOrder(name) { return { TOOL_BASH: 1000 }[name] },
}
const host = createTestHost({ dir, services: { systemPrompt } })
const mod = await import(path.join(dir, 'lib', 'index.js'))
mod.apply(host.ctx)

const prompt = sections.find((s) => s.name === 'adb-link:prompt')
if (!prompt) { console.error('FAIL prompt section was not registered'); process.exit(1) }
console.log('ok   prompt section registered at order', prompt.order)

const text = prompt.text()
console.log('ok   prompt text:', JSON.stringify(text.slice(0, 80)) + '…')

let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

check(text.includes('ADB 自动连接'), 'text names the plugin')
check(text.includes('行为边界'), 'text explains the behaviour boundary')
check(text.includes('先说再做'), 'text requires explaining before acting')
check(text.includes('只读'), 'text allows read-only queries directly')
check(text.includes('征得用户同意'), 'text requires consent for system-level or write operations')
check(text.includes('原因'), 'text explains why the boundary exists')
check(text.includes('允许一次'), 'text explains the panel approval')
check(text.includes('不要换参数绕过'), 'text forbids retrying with different arguments')

host.dispose?.()
console.log(failures === 0 ? '\nall prompt checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
