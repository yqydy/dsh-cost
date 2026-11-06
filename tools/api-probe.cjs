/**
 * 直接用宿主进程的浏览器会话 cookie 访问 DSH 的 `/api`，用来验证插件注册的
 * 精确 Fetch 路由到底通不通（浏览器面板里没法跑脚本，只能从外面探）。
 *
 * cookie 的构造口径完全照抄 @deepseek-ai/dsh-client-connection：
 *   name  = 'dsh-auth-' + base64url(sha256(authority))
 *   body  = base64url(JSON.stringify({version:1, authority, issuedAt, expiresAt}))
 *   value = 'v1.' + body + '.' + base64url(hmacSha256(secret, body))
 * secret 取自 $DSH_HOME/.credentials.yaml 里 client-connection/browser-session 这条
 * grant 记录。**本脚本不会打印任何密钥。**
 *
 *   node tools/api-probe.cjs [baseUrl] [path]
 *   node tools/api-probe.cjs http://127.0.0.1:43129 /api/dsh-daily-cost/summary
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash, createHmac } = require('node:crypto')

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:43129'
const targetPath = process.argv[3] ?? '/api/dsh-daily-cost/summary?days=3'

const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
  ? process.env.DSH_HOME.trim()
  : path.join(os.homedir(), '.dsh')

/** base64url（无填充）。 */
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** 从 .credentials.yaml 里抠出 browser-session 的 secret（只回二进制，不回显）。 */
function readSessionSecret() {
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

const authority = new URL(baseUrl).host
const secret = readSessionSecret()
const now = Date.now()
const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 3600_000 }
const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
const value = `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`

const url = `${baseUrl}${targetPath}`
console.log(`GET ${url}`)

fetch(url, { headers: { cookie: `${name}=${value}`, accept: 'application/json' } })
  .then(async (response) => {
    const text = await response.text()
    console.log(`status: ${response.status} ${response.statusText}`)
    console.log(`content-type: ${response.headers.get('content-type')}`)
    console.log(`body (${text.length} chars): ${text.slice(0, 700)}`)
    process.exit(response.ok ? 0 : 1)
  })
  .catch((error) => {
    console.error(`请求失败：${String(error)}`)
    process.exit(1)
  })
