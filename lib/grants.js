// 「允许一次」授权只留在内存里：引擎重启就失效，不写 state.json，
// 避免把一次性的放行变成永久的后门。key 是命令指纹（见 lib/risk.js）。
const TTL_MS = 120_000

const grants = new Map()

/** 放行一条命令一次，`ttlMs` 后自动失效。 */
export function allowOnce(key, ttlMs = TTL_MS) {
  if (typeof key !== 'string' || key === '') return false
  grants.set(key, Date.now() + Math.max(1_000, Number(ttlMs) || TTL_MS))
  return true
}

/** 是否还有效（顺手清掉过期的）。 */
export function hasGrant(key, now = Date.now()) {
  const expiresAt = grants.get(key)
  if (expiresAt === undefined) return false
  if (now >= expiresAt) {
    grants.delete(key)
    return false
  }
  return true
}

/** 用掉一次授权；返回这次是否真的放行。 */
export function consumeGrant(key, now = Date.now()) {
  if (!hasGrant(key, now)) return false
  grants.delete(key)
  return true
}

export function clearGrants() {
  grants.clear()
}

export function grantCount() {
  return grants.size
}
