// 运行 dsh-go 插件工具包自带的检查器（随 DSH Go App 的 dsh-go-plugin 技能
// 一起提供）。在装有该技能的手机上可直接使用。
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME || path.join(process.env.HOME || '/root', '.dsh')
const checker = process.env.DSH_GO_PLUGIN_KIT_CHECK
  || path.join(home, 'skills', 'dsh-go-plugin', 'kit', 'bin', 'check.mjs')

if (!existsSync(checker)) {
  console.log(`跳过检查：本机没有 dsh-go 插件工具包检查器 → ${checker}`)
  process.exit(0)
}

const result = spawnSync(process.execPath, [checker, root, '--load'], { stdio: 'inherit' })
process.exit(result.status ?? 1)
