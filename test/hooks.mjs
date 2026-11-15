// 让测试脚本从终端直接 import 插件时，也能解析 harness 自己的
// `@deepseek-ai/*` 包（引擎和工具包的检查器会各自安装同样的解析钩子）。
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let installed = false

export function installDshResolveHooks() {
  if (installed) return
  installed = true
  const parents = []
  const add = (packageDir) => {
    const bin = join(packageDir, 'lib', 'bin.js')
    if (existsSync(bin)) parents.push(pathToFileURL(bin).href)
  }
  if (process.env.DSH_DIR) add(process.env.DSH_DIR)
  add('/opt/dsh/node_modules/@deepseek-ai/dsh')
  for (const entry of (process.env.PATH ?? '').split(':')) {
    if (entry === '') continue
    add(join(entry, '..', 'lib', 'dsh'))
  }
  if (parents.length === 0) return
  registerHooks({
    resolve(specifier, context, next) {
      if (!specifier.startsWith('@deepseek-ai/')) return next(specifier, context)
      try {
        return next(specifier, context)
      } catch {}
      for (const parentURL of parents) {
        try {
          return next(specifier, { ...context, parentURL })
        } catch {}
      }
      return next(specifier, context)
    },
  })
}

installDshResolveHooks()
