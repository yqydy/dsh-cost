/**
 * dsh-daily-cost 自检：节假日计价（对照实验）。
 *
 * 验证的不只是「holidays 被读到快照里」，而是「holidays 真的改变了计价」：
 * 同一批真实会话日志折两遍 ——
 *   A) 不列任何节假日
 *   B) 把「今天」列为节假日
 * 若今天（按北京日期）落在高峰窗口内且有调用，B 的今日金额应当**恰好是 A 的一半**
 * （空闲价 = 高峰价 × offPeakDiscount = 0.5），且 peak/offPeak 归属对调、
 * 用量（调用数 / miss / hit / out）分毫不动。
 *
 * 注意：快照里的金额是 round(cost, 4) 的量化值，所以断言容差取 1e-3
 * （断言的实质是「恰好减半」，不是「逐位相等」）。
 *
 *   node test/holidays.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REAL_HOME = process.env.DSH_DAILY_COST_REAL_HOME ?? path.join(os.homedir(), 'AppData', 'Roaming', 'dsh-desktop-plus', 'harness')
const SESSIONS = path.join(REAL_HOME, 'sessions')

const pad = (n) => String(n).padStart(2, '0')
const dayKeyOf = (ms) => {
  const d = new Date(ms + 8 * 3600000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
const today = dayKeyOf(Date.now())

const { apply } = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href)

/** 用给定 holidays 折一遍真实日志，返回落盘快照。 */
async function fold(label, holidays) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-daily-cost-holidays-${label}-`))
  process.env.DSH_HOME = temp // 不放 sessions 子目录，避免 fs.watch 留住进程
  const logs = []
  apply(
    {
      logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]) },
      effect: (fn) => fn(),
      connection: undefined,
      inject: () => {},
    },
    { extraSessionRoots: [SESSIONS], writeSummaryFile: true, refreshMs: 60000, holidays },
  )
  const snapshotPath = path.join(temp, 'dsh-daily-cost', 'summary.json')
  let summary = null
  for (let i = 0; i < 480; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (!fs.existsSync(snapshotPath)) continue
    try {
      const candidate = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
      if (candidate?.scan?.foldedEvents > 0) { summary = candidate; break }
      summary = candidate
    } catch { /* 还在写 */ }
  }
  fs.rmSync(temp, { recursive: true, force: true })
  if (summary === null) throw new Error(`${label}: 没有生成快照`)
  return summary
}

const withoutHoliday = await fold('none', [])
const withToday = await fold('today', [today])

const row = (s) => ({
  cost: s.today.cost,
  peak: s.today.costPeak,
  offPeak: s.today.costOffPeak,
  calls: s.today.calls,
  miss: s.today.tokens.miss,
  hit: s.today.tokens.hit,
  out: s.today.tokens.out,
})

const a = row(withoutHoliday)
const b = row(withToday)

console.log(`今天（北京）: ${today}`)
console.log('A 不列节假日 :', JSON.stringify(a))
console.log('B 列为节假日 :', JSON.stringify(b))
console.log(`A.peakRule.holidays = ${JSON.stringify(withoutHoliday.peakRule.holidays)}`)
console.log(`B.peakRule.holidays = ${JSON.stringify(withToday.peakRule.holidays)}`)

let failures = 0
const fail = (m) => { failures += 1; console.error(`FAIL: ${m}`) }
const ok = (c, m) => { if (!c) fail(m) }
const TOL = 1e-3

ok(a.calls === b.calls, `两次调用数应相同：${a.calls} vs ${b.calls}`)
ok(a.miss === b.miss && a.hit === b.hit && a.out === b.out, '两次 token 数应相同（holidays 不应影响用量）')
ok(a.cost > 0, 'A 今日金额应为正（今天确实有高峰期调用；若今天是周末/节假日则本自检不适用）')
ok(Math.abs(b.cost - a.cost / 2) < TOL, `B 应恰好是 A 的一半：${b.cost} vs ${a.cost / 2}`)
ok(Math.abs(b.offPeak - a.cost / 2) < TOL && b.peak === 0, `B 应全部落在空闲：peak=${b.peak} offPeak=${b.offPeak}`)
ok(Math.abs(a.peak - a.cost) < TOL && a.offPeak === 0, `A 应全部落在高峰：peak=${a.peak} offPeak=${a.offPeak}`)

if (failures === 0) console.log(`\nOK：holidays 生效 —— 把今天列为节假日使金额从 ${a.cost} 变为 ${b.cost}（恰好 ×0.5），token 数不变`)
else console.error(`\n${failures} 项不符合预期`)

process.exit(failures === 0 ? 0 : 1)
