/**
 * 让 DSH 重新组合一次 profile，从而重算客户端 bundle 的 rev。
 *
 * 为什么需要它：客户端插件的 js 在 `node_modules` 里，HMR 只监听「配置类文件」
 * （profile manifest 的 dsh.profile.bundles、profile/home 的 patch），不监听
 * 插件源码；bundle 的 URL 带内容 rev，rev 不变浏览器可能直接吃缓存。
 * 在 profile 的 `cordis.patch.yml` 末尾维护**一行**时间戳注释，内容一变就触发
 * 重新组合；重复运行只替换那一行并清掉历史遗留注释，不会越堆越多。
 *
 *   node tools/recompose.cjs "<profile>/cordis.patch.yml"
 */
const fs = require('node:fs')

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node tools/recompose.cjs <profile>/cordis.patch.yml')
  process.exit(2)
}

const MARKER = '# dsh-daily-cost recompose marker:'
const text = fs.readFileSync(file, 'utf8')
const kept = []
let dropped = 0
for (const line of text.split('\n')) {
  // 本脚本自己写的标记行，以及历史上临时追加的说明行，都清掉。
  if (line.startsWith(MARKER) || /^#\s*\d{4}-\d{2}-\d{2}\s+dsh-daily-cost:/.test(line)) {
    dropped += 1
    continue
  }
  kept.push(line)
}
while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
kept.push('', `${MARKER} ${new Date().toISOString()}`, '')
fs.writeFileSync(file, kept.join('\n'), 'utf8')
console.log(`recompose marker refreshed; dropped ${dropped} old line(s); file now ${fs.statSync(file).size} bytes`)
