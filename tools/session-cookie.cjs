/**
 * 用宿主进程的浏览器会话 cookie 构造一个合法的 `dsh-auth-*` Cookie。
 *
 * cookie 口径完全照抄 @deepseek-ai/dsh-client-connection：
 *   name  = 'dsh-auth-' + base64url(sha256(authority))
 *   body  = base64url(JSON.stringify({version:1, authority, issuedAt, expiresAt}))
 *   value = 'v1.' + body + '.' + base64url(hmacSha256(secret, body))
 * secret 取自 $DSH_HOME/.credentials.yaml 里 client-connection/browser-session 这条
 * grant 记录。**本模块不会打印任何密钥。**
 *
 * @module tools/session-cookie
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash, createHmac } = require('node:crypto')

/** base64url（无填充）。 */
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** 从 .credentials.yaml 里抠出 browser-session 的 secret（只回二进制，不回显）。 */
function readSessionSecret(home) {
  const file = path.join(home, '.credentials.yaml')
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const keyAt = lines.findIndex((line) => line.includes('client-connection/browser-session'))
  if (keyAt === -1) throw new Error('凭据文件里没有 client-connection/browser-session 记录')
  for (let i = keyAt + 1; i < lines.length && i < keyAt + 20; i++) {
    const match = /^\s+secret:\s*(\S+)\s*$/.exec(lines[i])
    if (match !== null) {
      const raw = match[1].replace(/-/g, '+').replace(/_/g, '/')
      const secret = Buffer.from(raw, 'base64')
      if (secret.byteLength !== 32) throw new Error(`secret 长度异常：${secret.byteLength}`)
      return secret
    }
  }
  throw new Error('没有在 browser-session 记录里找到 secret')
}

/**
 * 给一个 baseUrl 造出它的合法会话 cookie。
 * @param baseUrl - 例如 http://127.0.0.1:43129
 * @param ttlMs - cookie 有效期（默认 1 小时）
 * @returns `{ name, value, header }`（header 可直接塞进请求头）。
 */
function mintSessionCookie(baseUrl, ttlMs = 3600_000) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  const authority = new URL(baseUrl).host
  const secret = readSessionSecret(home)
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + ttlMs }
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const value = `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
  const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`
  return { name, value, header: `${name}=${value}` }
}

module.exports = { mintSessionCookie, b64url }
