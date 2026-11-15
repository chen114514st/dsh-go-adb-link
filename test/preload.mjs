// 测试预加载：在插件模块加载前把 DSH_HOME 指到临时目录，
// 这样测试不会读写用户真实的 $DSH_HOME/dsh-go/adb-link/state.json。
// 用法：node --import ./test/preload.mjs test/unit.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-link-test-'))

process.env.DSH_HOME = dir

process.on('exit', () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
})
