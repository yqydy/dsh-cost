/**
 * 带着合法会话 cookie 取 DSH 的任意页面，并在响应体里搜一个正则，打印命中处的上下文。
 * 用来回答「浏览器实际拿到的是哪几份客户端 bundle」这类问题。
 *
 *   node tools/page-probe.cjs [baseUrl] [path] [regex]
 *   node tools/page-probe.cjs http://127.0.0.1:43129 / daily-cost
 */
const { mintSessionCookie } = require('./session-cookie.cjs')

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:43129'
const targetPath = process.argv[3] ?? '/'
const pattern = new RegExp(process.argv[4] ?? 'daily-cost', 'g')

const cookie = mintSessionCookie(baseUrl)
const url = `${baseUrl}${targetPath}`
console.log(`GET ${url}`)

fetch(url, { headers: { cookie: cookie.header, accept: 'text/html' } })
  .then(async (response) => {
    const text = await response.text()
    console.log(`status: ${response.status}  bytes: ${text.length}`)
    const hits = []
    let match
    while ((match = pattern.exec(text)) !== null && hits.length < 40) {
      hits.push(text.slice(Math.max(0, match.index - 120), Math.min(text.length, match.index + 160)).replace(/\s+/g, ' '))
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1
    }
    console.log(`matches: ${hits.length}`)
    for (const hit of hits) console.log(`  … ${hit}`)
  })
  .catch((error) => {
    console.error(`请求失败：${String(error)}`)
    process.exit(1)
  })
