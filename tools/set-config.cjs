/**
 * 在 profile 的 cordis.patch.yml 里维护本插件的配置覆盖行，并顺带刷新重新组合标记
 * （内容一变，HMR 就会重新组合 → 插件行按新 name/config 重挂）。
 *
 *   node tools/set-config.cjs "<profile>/cordis.patch.yml" <revision> [pluginId]
 *
 * 覆盖行的形态（loader 语义：config 是整体替换，所以这里只写我们自己认识的键）：
 *
 *   - id: dsh-daily-cost-host
 *     name: dsh-daily-cost-host
 *     config:
 *       revision: '4'
 *
 * 幂等：重复运行只会替换这一块，不会堆积。
 */
const fs = require('node:fs')

const file = process.argv[2]
const revision = process.argv[3] ?? '1'
const pluginId = process.argv[4] ?? 'dsh-daily-cost-host'
if (file === undefined) {
  console.error('usage: node tools/set-config.cjs <profile>/cordis.patch.yml <revision> [pluginId]')
  process.exit(2)
}

const MARKER = '# dsh-daily-cost recompose marker:'
const HEAD = `- id: ${pluginId}`
const LEGACY_HEADS = ['- id: dsh-daily-cost', HEAD]

const lines = fs.readFileSync(file, 'utf8').split('\n')
const kept = []
let dropped = 0
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  if (line.startsWith(MARKER)) {
    dropped += 1
    continue
  }
  if (LEGACY_HEADS.includes(line.trimEnd())) {
    // 吃掉这一条覆盖项的全部行，直到下一个顶层列表项或文件末尾。
    dropped += 1
    i += 1
    while (i < lines.length && !/^- /.test(lines[i])) i += 1
    i -= 1
    continue
  }
  kept.push(line)
}
while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()

kept.push('', HEAD, `  name: '${pluginId}'`, '  config:', `    revision: '${revision}'`, '', `${MARKER} ${new Date().toISOString()}`, '')
fs.writeFileSync(file, kept.join('\n'), 'utf8')
console.log(`config override written (id=${pluginId}, revision=${revision}); dropped ${dropped} old line(s); file now ${fs.statSync(file).size} bytes`)
