/**
 * 高峰/空闲时段与金额的独立复核。
 *
 * 与宿主半边刻意走不同的实现路径：
 *   - 时区换算用 `Intl.DateTimeFormat` 的 timeZone: 'Asia/Shanghai'（宿主是自己加 UTC+8 偏移）；
 *   - 时段判定用 Intl 给出的 weekday + h23 小时分钟（宿主是 UTC getter + 分钟数比较）；
 *   - 金额自己按官方价目表重算，再和插件快照里的 costPeak / costOffPeak / cost 对账。
 *
 *   node test/peak.mjs
 *
 * 判据：今天以前的每一天，`cost` / `costPeak` / `costOffPeak` 三项都必须与插件一致
 * （允许 1e-4 的浮点/四舍五入差）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const REAL_HOME = process.env.DSH_DAILY_COST_REAL_HOME ?? path.join(os.homedir(), 'AppData', 'Roaming', 'dsh-desktop-plus', 'harness')
const SESSIONS = path.join(REAL_HOME, 'sessions')
const SNAPSHOT = path.join(REAL_HOME, 'dsh-daily-cost', 'summary.json')

/** 官方高峰价（元/百万 tokens）。 */
const PRICES = {
  'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
}
const OFF_PEAK = 0.5

// --- 独立实现的时区/时段判定 ------------------------------------------------

const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
const fmtParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** 北京日期 + 是否高峰（周一至周五 09:00-12:00、14:00-18:00）。 */
function beijingTier(ms) {
  const date = fmtDay.format(new Date(ms)) // YYYY-MM-DD
  const parts = Object.fromEntries(fmtParts.formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  const weekday = parts.weekday
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  const weekend = weekday === 'Sat' || weekday === 'Sun'
  const inWindow = (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
  return { date, weekday, minutes, peak: !weekend && inWindow }
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const RE_ROUTE = /"provider":"([^"]+)","model":"([^"]+)"/
const RE_TIME = /"time":(\d+)/
const RE_USAGE = /"usage":\{"inputTokens":(\d+),"outputTokens":(\d+),"cacheReadTokens":(\d+),"cacheWriteTokens":(\d+)/

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name === 'session.v4.jsonl.zstd') out.push(full)
  }
  return out
}

const byDay = new Map()
const weekdayOfDay = new Map()
const tierCalls = { peak: 0, offPeak: 0 }

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
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
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
      const time = Number(timeMatch[1])
      const { date, weekday, peak } = beijingTier(time)
      weekdayOfDay.set(date, weekday)

      const price = PRICES[model] ?? null
      const miss = Number(usage[1])
      const out = Number(usage[2])
      const hit = Number(usage[3])
      const factor = peak ? 1 : OFF_PEAK
      const cost = price === null ? 0 : ((miss * price.cacheMiss + hit * price.cacheHit + out * price.output) / 1e6) * factor

      const day = byDay.get(date) ?? { calls: 0, peakCalls: 0, cost: 0, costPeak: 0, costOffPeak: 0 }
      day.calls += 1
      if (peak) day.peakCalls += 1
      day.cost += cost
      if (peak) day.costPeak += cost
      else day.costOffPeak += cost
      byDay.set(date, day)
      tierCalls[peak ? 'peak' : 'offPeak'] += 1
    }
  }
}

// --- 与插件快照对账 ---------------------------------------------------------

const summary = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'))
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

console.log(`口径：北京时间（Intl timeZone=Asia/Shanghai，独立于宿主的 UTC+8 手算）`)
console.log(`高峰窗口：${summary.peakRule.windows.join(' / ')}，周一到周五，空闲折扣 ${summary.peakRule.offPeakDiscount}`)
console.log(`时段命中：高峰 ${tierCalls.peak} 次调用 / 空闲 ${tierCalls.offPeak} 次调用\n`)

let failures = 0
const fail = (m) => {
  failures += 1
  console.error(`FAIL: ${m}`)
}
const near = (a, b) => Math.abs(a - b) < 1e-4

console.log('日期        星期  调用(高峰)   独立 总价      插件 总价      独立 高峰/空闲        插件 高峰/空闲')
for (const date of [...byDay.keys()].sort()) {
  const mine = byDay.get(date)
  const theirs = (summary.days ?? []).find((d) => d.date === date)
  const mark = date === today ? '  ← 今天（进行中）' : ''
  console.log(
    `${date}  ${weekdayOfDay.get(date)?.padEnd(4)} ${String(mine.calls).padStart(5)}(${String(mine.peakCalls).padStart(5)})` +
      `  ${mine.cost.toFixed(4).padStart(11)}  ${(theirs?.cost ?? 0).toFixed(4).padStart(11)}` +
      `  ${mine.costPeak.toFixed(4).padStart(9)}/${mine.costOffPeak.toFixed(4).padStart(9)}` +
      `  ${(theirs?.costPeak ?? 0).toFixed(4).padStart(9)}/${(theirs?.costOffPeak ?? 0).toFixed(4).padStart(9)}${mark}`,
  )
  if (date === today) continue
  if (theirs === undefined) {
    fail(`${date}：插件快照里没有这一天`)
    continue
  }
  if (!near(mine.cost, theirs.cost)) fail(`${date} 总价不一致：${mine.cost} != ${theirs.cost}`)
  if (!near(mine.costPeak, theirs.costPeak)) fail(`${date} 高峰金额不一致：${mine.costPeak} != ${theirs.costPeak}`)
  if (!near(mine.costOffPeak, theirs.costOffPeak)) fail(`${date} 空闲金额不一致：${mine.costOffPeak} != ${theirs.costOffPeak}`)
  if (mine.calls !== theirs.calls) fail(`${date} 调用数不一致：${mine.calls} != ${theirs.calls}`)
}

// 时段确实被用上了吗？（两条证据：真有高峰调用；且高峰/空闲合计 = 总价）
const totalPeak = [...byDay.values()].reduce((s, d) => s + d.costPeak, 0)
const totalOff = [...byDay.values()].reduce((s, d) => s + d.costOffPeak, 0)
const total = [...byDay.values()].reduce((s, d) => s + d.cost, 0)
console.log(`\n合计：高峰 ${totalPeak.toFixed(4)} + 空闲 ${totalOff.toFixed(4)} = ${total.toFixed(4)} 元`)
if (!near(totalPeak + totalOff, total)) fail('高峰 + 空闲 != 总价')
if (tierCalls.peak === 0) fail('一次高峰调用都没有，时段判定可能没生效')
if (tierCalls.offPeak === 0) fail('一次空闲调用都没有，时段判定可能没生效')

// 如果同一档价格下把高峰当空闲算，金额应当明显更低——证明折扣确实在起作用。
const sameAsOffPeak = totalOff + totalPeak * OFF_PEAK
console.log(`反证：若把高峰也按空闲价算，总价会是 ${sameAsOffPeak.toFixed(4)} 元（比真实值低 ${(total - sameAsOffPeak).toFixed(4)} 元）`)
if (Math.abs(total - sameAsOffPeak) < 1e-6 && tierCalls.peak > 0) fail('高峰与空闲算出同一个价，折扣没生效')

console.log(failures === 0 ? '\nOK：时段判定与金额都与独立实现一致' : `\n${failures} 项不一致`)
process.exit(failures === 0 ? 0 : 1)
