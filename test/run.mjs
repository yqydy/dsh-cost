/**
 * dsh-daily-cost 自检（差分口径）：
 *
 * 1. 用一份假 ctx 直接跑宿主半边（`apply`）：扫真实会话日志 → 折账 → 写快照。
 * 2. 用一份**独立实现**重算同一批日志：它的字段提取走正则、逐帧处理，
 *    与宿主半边的「前缀快判 + 花括号配对 + JSON.parse 小对象」是两条不同的路径。
 * 3. 比对：**今天以前的每一天必须逐日完全一致**（那些天不会再写入）；
 *    今天允许偏差（两份读数之间仍在写入），但插件不能比独立读数**多**算。
 *
 *   node test/run.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

const REAL_HOME = process.env.DSH_DAILY_COST_REAL_HOME ?? path.join(os.homedir(), 'AppData', 'Roaming', 'dsh-desktop-plus', 'harness')
const SESSIONS = path.join(REAL_HOME, 'sessions')

// --- 独立实现 ---------------------------------------------------------------

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const RE_ROUTE = /"provider":"([^"]+)","model":"([^"]+)"/
const RE_TIME = /"time":(\d+)/
const RE_USAGE = /"usage":\{"inputTokens":(\d+),"outputTokens":(\d+),"cacheReadTokens":(\d+),"cacheWriteTokens":(\d+)/

const pad = (n) => String(n).padStart(2, '0')
function dayKeyOf(ms) {
  const d = new Date(ms + 8 * 3600000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name === 'session.v4.jsonl.zstd') out.push(full)
  }
  return out
}

const independent = new Map()
const startedAt = Date.now()
let referenceFrames = 0
let referenceLines = 0

for (const file of walk(SESSIONS, [])) {
  const buf = fs.readFileSync(file)
  const starts = []
  let at = buf.indexOf(MAGIC, 0)
  while (at !== -1) {
    starts.push(at)
    at = buf.indexOf(MAGIC, at + 1)
  }
  let model = null
  for (let i = 0; i < starts.length; i++) {
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length
    let text
    try {
      text = zlib.zstdDecompressSync(buf.subarray(starts[i], to)).toString('utf8')
    } catch {
      continue
    }
    referenceFrames += 1
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      referenceLines += 1
      if (line.includes('request/header')) {
        const route = RE_ROUTE.exec(line)
        if (route !== null) model = route[2]
        continue
      }
      if (!line.includes('assistant/message')) continue
      const usage = RE_USAGE.exec(line)
      if (usage === null) continue
      const timeMatch = RE_TIME.exec(line)
      if (timeMatch === null) continue
      const key = dayKeyOf(Number(timeMatch[1]))
      const day = independent.get(key) ?? { calls: 0, miss: 0, hit: 0, out: 0, models: new Set() }
      day.calls += 1
      day.miss += Number(usage[1])
      day.out += Number(usage[2])
      day.hit += Number(usage[3])
      day.models.add(model ?? 'unknown')
      independent.set(key, day)
    }
  }
}
const referenceMs = Date.now() - startedAt

// --- 跑插件 -----------------------------------------------------------------

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-daily-cost-test-'))
process.env.DSH_HOME = temp // 不放 sessions 子目录：避免测试进程被 fs.watch 留住

const { apply } = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href)

const logs = []
apply(
  {
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]) },
    effect: (fn) => fn(),
    connection: undefined,
    inject: () => {},
  },
  { extraSessionRoots: [SESSIONS], writeSummaryFile: true, refreshMs: 60000 },
)

const snapshotPath = path.join(temp, 'dsh-daily-cost', 'summary.json')
let summary = null
// 注意：插件在 apply 结尾会先落一次「还没扫完」的快照，所以不能一看到文件就收工，
// 要等到扫出调用记录为止。
for (let i = 0; i < 480; i++) {
  await new Promise((r) => setTimeout(r, 250))
  if (!fs.existsSync(snapshotPath)) continue
  try {
    const candidate = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
    if (candidate?.scan?.foldedEvents > 0) {
      summary = candidate
      break
    }
    summary = candidate
  } catch {
    /* 还在写 */
  }
}

// --- 比对 -------------------------------------------------------------------

let failures = 0
const fail = (message) => {
  failures += 1
  console.error(`FAIL: ${message}`)
}
const today = dayKeyOf(Date.now())

console.log(`独立实现：${referenceFrames} 帧 / ${referenceLines} 行 / ${referenceMs} ms`)

if (summary === null) {
  fail('没有生成快照')
} else {
  console.log(
    `插件扫描：${summary.scan.files} 个文件 / ${summary.scan.foldedEvents} 次调用 / ${summary.scan.lastScanMs} ms / skip=${summary.scan.skips} reset=${summary.scan.resets} error=${summary.scan.lastError}`,
  )
  console.log(`今日(${today})：${summary.currency} ${summary.today.cost}  调用 ${summary.today.calls}  miss ${summary.today.tokens.miss}  hit ${summary.today.tokens.hit}  out ${summary.today.tokens.out}`)
  console.log(
    `近 7 天：${summary.currency} ${summary.last7.cost}（高峰 ${summary.last7.costPeak} / 空闲 ${summary.last7.costOffPeak}，缓存命中率 ${(summary.last7.tokens.hitRate * 100).toFixed(2)}%）`,
  )
  console.log(`价目：${JSON.stringify(summary.prices)}`)
  console.log(`时段：${JSON.stringify(summary.peakRule.windows)} ${summary.peakRule.days} 空闲折扣 ${summary.peakRule.offPeakDiscount}`)
  console.log('逐日：')
  const pluginByDay = new Map(summary.days.map((d) => [d.date, d]))
  const allDays = [...new Set([...independent.keys(), ...pluginByDay.keys()])].sort()
  for (const day of allDays) {
    const mine = independent.get(day)
    const theirs = pluginByDay.get(day)
    const mark = day === today ? '  （今天，允许增长）' : ''
    console.log(
      `  ${day}  独立 miss ${String(mine?.miss ?? 0).padStart(9)} hit ${String(mine?.hit ?? 0).padStart(11)} out ${String(mine?.out ?? 0).padStart(8)} calls ${String(mine?.calls ?? 0).padStart(5)}` +
        `  |  插件 miss ${String(theirs?.tokens.miss ?? 0).padStart(9)} hit ${String(theirs?.tokens.hit ?? 0).padStart(11)} out ${String(theirs?.tokens.out ?? 0).padStart(8)} calls ${String(theirs?.calls ?? 0).padStart(5)}` +
        `  = ${summary.currency} ${theirs?.cost ?? 0}${mark}`,
    )
    if (day === today) continue
    if (mine === undefined || theirs === undefined) {
      fail(`${day}：一边缺数据`)
      continue
    }
    if (mine.miss !== theirs.tokens.miss) fail(`${day} miss 不一致：${mine.miss} != ${theirs.tokens.miss}`)
    if (mine.hit !== theirs.tokens.hit) fail(`${day} hit 不一致：${mine.hit} != ${theirs.tokens.hit}`)
    if (mine.out !== theirs.tokens.out) fail(`${day} out 不一致：${mine.out} != ${theirs.tokens.out}`)
    if (mine.calls !== theirs.calls) fail(`${day} 调用数不一致：${mine.calls} != ${theirs.calls}`)
  }

  const mineToday = independent.get(today) ?? { miss: 0, hit: 0, out: 0, calls: 0 }
  if (summary.today.tokens.miss > mineToday.miss) fail('今天的 miss 比独立读数还多（不可能）')
  if (summary.today.calls > mineToday.calls) fail('今天的调用数比独立读数还多（不可能）')
  if (summary.scan.skips !== 0) fail(`出现跳帧 skip=${summary.scan.skips}`)
  if (summary.scan.resets !== 0) fail(`出现重折 reset=${summary.scan.resets}`)
  if (!(summary.all.cost > 0)) fail('总金额为 0')
  if (summary.models.some((m) => m.priced === false)) fail('有未定价模型')
  if (summary.scan.lastError !== null) fail(`扫描有错：${summary.scan.lastError}`)
  if (summary.today.costPeak < 0 || summary.today.costOffPeak < 0) fail('金额为负')
}

console.log('\n日志：')
for (const [level, message] of logs) console.log(`  ${level}: ${message}`)

fs.rmSync(temp, { recursive: true, force: true })

if (failures === 0) console.log('\nOK：今天以前的每一天都与独立实现完全一致')
else console.error(`\n${failures} 项不一致`)

process.exit(failures === 0 ? 0 : 1)
