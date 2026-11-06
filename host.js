/**
 * dsh-daily-cost — 宿主半边。
 *
 * ## 它做什么
 *
 * 1. 把本机所有 session 日志（`<DSH_HOME>/sessions/**\/session.v4.jsonl.zstd`）折成一张
 *    「按北京日期 × 模型」的用量账本。每个 `assistant/message` 事件自带 provider 用量
 *    （`inputTokens` = 缓存未命中输入、`cacheReadTokens` = 缓存命中输入、`outputTokens`），
 *    事件自带的 `time` 决定它属于哪一天、以及当时是高峰还是空闲时段。
 * 2. 用 DeepSeek 官网的价格表把 token 折成金额（见 `DEFAULT_PRICES`；高峰/空闲按官方
 *    规则：北京时间周一至周五 09:00-12:00 与 14:00-18:00 为高峰，其余（含周末、
 *    法定节假日全天）为空闲，空闲价 = 高峰价的一半）。
 * 3. 通过 `GET /api/dsh-daily-cost/summary` 把结果交给浏览器半边（同一进程、同源、
 *    走 Connection 的 cookie 认证），并在 `$DSH_HOME/dsh-daily-cost/summary.json`
 *    落一份同样的快照，方便排查与外部读取。
 *
 * ## 为什么读日志文件而不是订阅会话事件
 *
 * 投影（`tokenUsage`）是**单会话累计**的，没有时间戳，因此无法回答「今天花了多少」；
 * 而「今天」天然是跨会话的（主会话 + 子代理 + 其它窗口 + 历史会话）。持久 session
 * 日志是唯一同时带时间戳与 provider 用量的真相来源，所以这里直接回放它：
 * 启动时全量折一次，之后靠 `fs.watch` 增量折新追加的 zstd 帧。
 *
 * ## 增量解码
 *
 * 每次追加写都是一个**独立的 zstd 帧**（实测一帧≈一行 JSONL），因此增量 = 从上次
 * 读到的字节偏移继续找下一个魔数 `28 B5 2F FD` 并逐帧解压。三条防御：
 * - 尾部半个帧（正在写、或崩溃留下）→ 本次停止，下次再来；
 * - 魔数误命中压缩数据内部 → 该候选解压失败且后面还有候选时，跳过它继续（`skipBad`），
 *   最多丢一个坏帧，绝不会卡死；
 * - 文件被截断/替换 → 偏移回退到 0，重新折。
 *
 * ## 兜底
 *
 * 任何一步失败都只影响这一次刷新：不会抛到宿主、不会阻塞 agent。价格表、时段窗口、
 * 节假日、扫描根、刷新间隔全部可配置（见 `normalizeConfig`）。
 *
 * @module dsh-daily-cost
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

/** 会话日志文件名（实测全部会话都叫这个）。 */
const SESSION_FILE = 'session.v4.jsonl.zstd'
/** zstd 帧魔数。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** 浏览器半边取的路径（必须落在 Connection 的 `/api` 共享通道下）。 */
const ROUTE_PATH = '/api/dsh-daily-cost/summary'
/** 快照落盘目录名（相对 $DSH_HOME）。 */
const DATA_DIR = 'dsh-daily-cost'
/** 北京时区固定偏移：中国大陆不实行夏令时，UTC+8 是精确值。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * DeepSeek 官方价格，单位：元 / 百万 tokens，**高峰时段**价。
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/（2026-09-10 04:00 UTC 起的现行价目）。
 * 空闲价 = 高峰价 × `offPeakDiscount`（官方为 0.5）。
 * 官方**没有**缓存写入费与缓存存储费，所以 `cacheWriteTokens` 不计价。
 */
const DEFAULT_PRICES_CNY = {
  'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
}
/** 官方英文页只发布美元价，与人民币价是两张独立价目表（不做汇率换算）。 */
const DEFAULT_PRICES_USD = {
  'deepseek-flash': { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  'deepseek-v4-pro': { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
}
/** 旧模型名 → 现行模型（官方说明：旧名仍可调用，由 V4.1-Flash 提供服务并按 Flash 计费）。 */
const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
}

const DEFAULTS = {
  currency: 'CNY',
  /** 高峰/空闲的比值（官方：空闲 = 高峰的一半）。 */
  offPeakDiscount: 0.5,
  /** 高峰时段窗口，单位：北京时间的「分钟」[起, 止)。 */
  peakWindows: [[9 * 60, 12 * 60], [14 * 60, 18 * 60]],
  /** 法定节假日（全天算空闲），格式 'YYYY-MM-DD'，北京时间。 */
  holidays: [],
  /** 额外扫描根；默认只用 $DSH_HOME/sessions。 */
  extraSessionRoots: [],
  /** 账本保留天数：早于这个天数的旧事件不进入内存账本。 */
  retainDays: 120,
  /** 兜底轮询间隔（毫秒）；实时性主要靠 fs.watch。 */
  refreshMs: 20000,
  /** 浏览器半边默认取多少天。 */
  defaultDays: 30,
  /** 是否把快照落盘到 $DSH_HOME/dsh-daily-cost/summary.json。 */
  writeSummaryFile: true,
  /** 价格覆盖：{ '模型名': { cacheHit, cacheMiss, output } }，按高峰价给。 */
  prices: null,
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const pad2 = (n) => (n < 10 ? `0${n}` : String(n))

/** 解析 DSH home：优先 $DSH_HOME，其次 ~/.dsh（与 @deepseek-ai/dsh-home-paths 同口径）。 */
function resolveHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/** 一天的键与北京时间的各个字段。 */
function beijingParts(ms) {
  const d = new Date(ms + BEIJING_OFFSET_MS)
  return {
    key: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    date: d,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dow: d.getUTCDay(),
  }
}

/** 把毫秒时间归到北京日期键。 */
const dayKey = (ms) => beijingParts(ms).key

/**
 * 从一行 JSON 里取出某个键对应的对象字面量并解析。
 *
 * 用它替代整行 `JSON.parse`：session 日志里一行可能有几 MB（工具 schema、长正文），
 * 而我们只要 `usage` / `config` 这两个小对象。取值用花括号配对；这两个对象的取值
 * 全是数字或短字符串，不含嵌套花括号的字符串，因此配对是安全的。
 * @param line - 一行 JSONL 文本。
 * @param marker - 形如 `"usage":{` 的起始标记。
 * @returns 解析后的对象，取不到时返回 null。
 */
function pickObject(line, marker) {
  const at = line.indexOf(marker)
  if (at === -1) return null
  const start = at + marker.length - 1
  let depth = 0
  for (let i = start; i < line.length; i++) {
    const ch = line[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(line.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** 事件信封里的 `time`（信封第一个 `"time":` 就是它）。 */
function pickTime(line) {
  const m = /"time":(\d+)/.exec(line)
  return m === null ? null : Number(m[1])
}

/** 该行是不是某类事件：先用信封前缀快速判断，前缀不符再退回一次性完整解析。 */
function isEvent(line, type) {
  if (line.startsWith(`{"type":"${type}"`)) return true
  if (!line.includes(`"${type}"`)) return false
  try {
    return JSON.parse(line).type === type
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 价目表与成本
// ---------------------------------------------------------------------------

/** 取模型的高峰价；未定价返回 null。 */
function priceOf(model, prices) {
  const key = String(model ?? '').trim().toLowerCase()
  if (key.length === 0) return null
  const bare = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
  const candidates = [key, bare, MODEL_ALIASES[bare]]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const hit = prices[candidate]
    if (hit !== undefined) return hit
  }
  return null
}

/** 判断某个时刻是高峰还是空闲（官方规则，北京时间）。 */
function tierOf(ms, cfg) {
  const p = beijingParts(ms)
  if (p.dow === 0 || p.dow === 6) return 'offPeak'
  if (cfg.holidaySet.has(p.key)) return 'offPeak'
  for (const [from, to] of cfg.peakWindows) {
    if (p.minutes >= from && p.minutes < to) return 'peak'
  }
  return 'offPeak'
}

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

/** 单文件账本：该文件贡献的按日聚合 + 续读游标。 */
function newFileState() {
  return { offset: 0, days: new Map(), model: null, carry: '', skips: 0, resets: 0, foldedEvents: 0, frames: 0 }
}

function newDay() {
  return { calls: 0, miss: 0, hit: 0, out: 0, write: 0, cost: 0, costPeak: 0, costOffPeak: 0, models: new Map() }
}

function newModelAgg() {
  return { calls: 0, miss: 0, hit: 0, out: 0, write: 0, cost: 0, priced: true }
}

/**
 * 把一段解出来的 JSONL 文本折进单文件账本。
 * 只认两种事件：`request/header`（决定此后每个请求走哪个模型）与 `assistant/message`
 * （自带 provider 用量；一次尝试一条，重试会有多条，各自计费）。
 *
 * 跨帧的半行由 `state.carry` 兜住：一帧理论上可能在某一行中间结束（实测不会，
 * 因为每次追加写的都是完整行，但这里不假设它）。
 */
function foldText(state, text, cfg) {
  if (text.length === 0) return
  const chunk = state.carry.length > 0 ? state.carry + text : text
  const lines = chunk.split('\n')
  state.carry = lines.pop() ?? ''
  for (const line of lines) {
    if (line.length === 0) continue
    if (line.includes('request/header')) {
      if (!isEvent(line, 'request/header')) continue
      const conf = pickObject(line, '"config":{')
      if (conf !== null && typeof conf.model === 'string') state.model = conf.model
      continue
    }
    if (!line.includes('assistant/message')) continue
    if (!isEvent(line, 'assistant/message')) continue
    const usage = pickObject(line, '"usage":{')
    if (usage === null || typeof usage.inputTokens !== 'number') continue
    const time = pickTime(line) ?? Date.now()
    if (time < cfg.retainFrom) continue

    const date = dayKey(time)
    const model = state.model ?? 'unknown'
    const tier = tierOf(time, cfg)
    const price = priceOf(model, cfg.prices)
    const factor = tier === 'peak' ? 1 : cfg.offPeakDiscount
    const miss = usage.inputTokens ?? 0
    const hit = usage.cacheReadTokens ?? 0
    const out = usage.outputTokens ?? 0
    const write = usage.cacheWriteTokens ?? 0
    const cost = price === null
      ? 0
      : ((miss * price.cacheMiss + hit * price.cacheHit + out * price.output) / 1e6) * factor

    let day = state.days.get(date)
    if (day === undefined) {
      day = newDay()
      state.days.set(date, day)
    }
    day.calls += 1
    day.miss += miss
    day.hit += hit
    day.out += out
    day.write += write
    day.cost += cost
    if (tier === 'peak') day.costPeak += cost
    else day.costOffPeak += cost

    let agg = day.models.get(model)
    if (agg === undefined) {
      agg = newModelAgg()
      agg.priced = price !== null
      day.models.set(model, agg)
    }
    agg.calls += 1
    agg.miss += miss
    agg.hit += hit
    agg.out += out
    agg.write += write
    agg.cost += cost
    state.foldedEvents += 1
  }
}

/**
 * 解一段「从某个帧边界开始」的 zstd 字节流，逐帧回调。
 *
 * 逐帧（而不是先拼成一个大字符串）是为了内存：本机存在 23 MB 压缩、解压后上百 MB
 * 的会话日志，整体拼接会在启动时留下一个巨大的瞬时字符串。
 *
 * @param buf - 本次新读到的字节。
 * @param skipBad - 遇到解不开且后面还有候选帧的字节段时，是否跳过它继续。
 * @param onText - 每个成功解出的帧文本回调。
 * @returns `{ consumed, skips, frames }`；`consumed` 是本次确认消费的字节数。
 */
function decodeAppended(buf, skipBad, onText) {
  const starts = []
  let at = buf.indexOf(ZSTD_MAGIC, 0)
  while (at !== -1) {
    starts.push(at)
    at = buf.indexOf(ZSTD_MAGIC, at + 1)
  }
  let consumed = 0
  let skips = 0
  let frames = 0
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]
    if (from > consumed) {
      // 上一个候选之后有无法归属的字节：只有当它是坏帧且我们允许跳过时才继续。
      if (!skipBad) break
      consumed = from
    }
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length
    let text = null
    try {
      text = zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8')
    } catch {
      text = null
    }
    if (text === null) {
      const hasLaterCandidate = i + 1 < starts.length
      if (!skipBad || !hasLaterCandidate) break
      // 坏帧（多为压缩数据里误命中的魔数）：跳过它，下一个候选继续。
      skips += 1
      consumed = to
      continue
    }
    onText(text)
    frames += 1
    consumed = to
  }
  return { consumed, skips, frames }
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

/** 递归找会话日志文件（只认 `session.v4.jsonl.zstd`）。 */
async function listSessionFiles(root, out, depth) {
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length > 5000 || depth > 6) return
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) await listSessionFiles(full, out, depth + 1)
    else if (entry.isFile() && entry.name === SESSION_FILE) out.push(full)
  }
}

/** 从文件的 `offset` 处读到末尾。 */
async function readRange(file, offset) {
  let handle
  try {
    handle = await fsp.open(file, 'r')
    const stat = await handle.stat()
    if (stat.size <= offset) return { bytes: Buffer.alloc(0), size: stat.size }
    const length = stat.size - offset
    const buf = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buf, 0, length, offset)
    return { bytes: buf.subarray(0, bytesRead), size: stat.size }
  } catch {
    return null
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/** 把各文件账本合并成一张按日表。 */
function mergeDays(files) {
  const merged = new Map()
  for (const state of files.values()) {
    for (const [date, day] of state.days) {
      let target = merged.get(date)
      if (target === undefined) {
        target = newDay()
        merged.set(date, target)
      }
      target.calls += day.calls
      target.miss += day.miss
      target.hit += day.hit
      target.out += day.out
      target.write += day.write
      target.cost += day.cost
      target.costPeak += day.costPeak
      target.costOffPeak += day.costOffPeak
      for (const [model, agg] of day.models) {
        let m = target.models.get(model)
        if (m === undefined) {
          m = newModelAgg()
          m.priced = agg.priced
          target.models.set(model, m)
        }
        m.calls += agg.calls
        m.miss += agg.miss
        m.hit += agg.hit
        m.out += agg.out
        m.write += agg.write
        m.cost += agg.cost
      }
    }
  }
  return merged
}

const round = (value, digits = 6) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function dayView(date, day) {
  return {
    date,
    calls: day.calls,
    tokens: { miss: day.miss, hit: day.hit, out: day.out, write: day.write },
    cost: round(day.cost, 4),
    costPeak: round(day.costPeak, 4),
    costOffPeak: round(day.costOffPeak, 4),
    models: [...day.models.entries()]
      .map(([model, agg]) => ({
        model,
        calls: agg.calls,
        cost: round(agg.cost, 4),
        tokens: { miss: agg.miss, hit: agg.hit, out: agg.out, write: agg.write },
        priced: agg.priced,
      }))
      .sort((a, b) => b.cost - a.cost || b.calls - a.calls),
  }
}

/** 组给浏览器半边的 JSON。 */
function buildSummary(state, cfg, options) {
  const merged = mergeDays(state.files)
  const dates = [...merged.keys()].sort().reverse()
  const todayKey = dayKey(Date.now())
  const wanted = Number.isFinite(options.days) && options.days > 0 ? Math.min(options.days, 400) : cfg.defaultDays

  const sumWindow = (n) => {
    let cost = 0
    let costPeak = 0
    let costOffPeak = 0
    let calls = 0
    let miss = 0
    let hit = 0
    let out = 0
    for (const date of dates.slice(0, n)) {
      const day = merged.get(date)
      cost += day.cost
      costPeak += day.costPeak
      costOffPeak += day.costOffPeak
      calls += day.calls
      miss += day.miss
      hit += day.hit
      out += day.out
    }
    return {
      cost: round(cost, 4),
      costPeak: round(costPeak, 4),
      costOffPeak: round(costOffPeak, 4),
      calls,
      tokens: { miss, hit, out, hitRate: miss + hit > 0 ? round(hit / (miss + hit), 4) : 0 },
    }
  }

  const emptyDay = dayView(todayKey, newDay())
  const today = merged.has(todayKey) ? dayView(todayKey, merged.get(todayKey)) : emptyDay
  const models = new Map()
  for (const date of dates) {
    for (const [model, agg] of merged.get(date).models) {
      let m = models.get(model)
      if (m === undefined) {
        m = newModelAgg()
        m.priced = agg.priced
        models.set(model, m)
      }
      m.calls += agg.calls
      m.miss += agg.miss
      m.hit += agg.hit
      m.out += agg.out
      m.write += agg.write
      m.cost += agg.cost
    }
  }

  return {
    ok: true,
    plugin: 'dsh-daily-cost',
    version: 1,
    generatedAt: Date.now(),
    timeZone: 'Asia/Shanghai (UTC+8)',
    currency: cfg.currency,
    priceUnit: 'per 1M tokens (peak listed; off-peak = peak x ' + cfg.offPeakDiscount + ')',
    prices: cfg.prices,
    peakRule: {
      windows: cfg.peakWindows.map(([from, to]) => `${pad2(Math.floor(from / 60))}:${pad2(from % 60)}-${pad2(Math.floor(to / 60))}:${pad2(to % 60)}`),
      days: 'Mon-Fri (Beijing), excluding listed holidays',
      offPeakDiscount: cfg.offPeakDiscount,
      holidays: [...cfg.holidaySet].sort(),
    },
    today,
    yesterday: merged.has(dayKey(Date.now() - 86400000)) ? dayView(dayKey(Date.now() - 86400000), merged.get(dayKey(Date.now() - 86400000))) : null,
    last7: sumWindow(7),
    last30: sumWindow(30),
    all: sumWindow(dates.length),
    days: dates.slice(0, wanted).map((date) => dayView(date, merged.get(date))),
    models: [...models.entries()]
      .map(([model, agg]) => ({
        model,
        calls: agg.calls,
        cost: round(agg.cost, 4),
        tokens: { miss: agg.miss, hit: agg.hit, out: agg.out, write: agg.write },
        priced: agg.priced,
      }))
      .sort((a, b) => b.cost - a.cost),
    scan: {
      roots: cfg.roots,
      files: state.files.size,
      foldedEvents: [...state.files.values()].reduce((sum, s) => sum + s.foldedEvents, 0),
      skips: [...state.files.values()].reduce((sum, s) => sum + s.skips, 0),
      resets: [...state.files.values()].reduce((sum, s) => sum + s.resets, 0),
      lastScanAt: state.lastScanAt,
      lastScanMs: state.lastScanMs,
      lastError: state.lastError,
    },
    route: state.route,
  }
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

function normalizeConfig(raw, log) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const currency = String(input.currency ?? DEFAULTS.currency).toUpperCase() === 'USD' ? 'USD' : 'CNY'
  const base = currency === 'USD' ? DEFAULT_PRICES_USD : DEFAULT_PRICES_CNY
  const prices = { ...base }
  if (input.prices !== null && typeof input.prices === 'object') {
    for (const [model, value] of Object.entries(input.prices)) {
      if (value === null || typeof value !== 'object') continue
      const cacheHit = Number(value.cacheHit)
      const cacheMiss = Number(value.cacheMiss)
      const output = Number(value.output)
      if (!Number.isFinite(cacheHit) || !Number.isFinite(cacheMiss) || !Number.isFinite(output)) continue
      prices[String(model).trim().toLowerCase()] = { cacheHit, cacheMiss, output }
    }
  }

  const windows = []
  const rawWindows = Array.isArray(input.peakWindows) ? input.peakWindows : DEFAULTS.peakWindows
  for (const window of rawWindows) {
    if (!Array.isArray(window) || window.length !== 2) continue
    const from = Number(window[0])
    const to = Number(window[1])
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > 1440 || to <= from) continue
    windows.push([from, to])
  }

  const holidays = Array.isArray(input.holidays) ? input.holidays.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) : []
  const extraRoots = Array.isArray(input.extraSessionRoots) ? input.extraSessionRoots.filter((p) => typeof p === 'string' && p.trim().length > 0) : []
  const home = resolveHome()
  const roots = [path.join(home, 'sessions'), ...extraRoots.map((p) => path.resolve(p))]
  const retainDays = Number.isFinite(Number(input.retainDays)) ? Math.max(1, Number(input.retainDays)) : DEFAULTS.retainDays
  const refreshMs = Number.isFinite(Number(input.refreshMs)) ? Math.max(2000, Number(input.refreshMs)) : DEFAULTS.refreshMs

  if (windows.length === 0) {
    windows.push(...DEFAULTS.peakWindows)
    log?.warn?.('[dsh-daily-cost] peakWindows 配置无效，已回退到官方默认窗口')
  }

  return {
    currency,
    prices,
    offPeakDiscount: Number.isFinite(Number(input.offPeakDiscount)) ? Number(input.offPeakDiscount) : DEFAULTS.offPeakDiscount,
    peakWindows: windows,
    holidaySet: new Set(holidays),
    roots,
    home,
    retainDays,
    retainFrom: Date.now() - retainDays * 86400000,
    refreshMs,
    defaultDays: Number.isFinite(Number(input.defaultDays)) ? Math.min(Math.max(1, Number(input.defaultDays)), 400) : DEFAULTS.defaultDays,
    writeSummaryFile: input.writeSummaryFile !== false,
  }
}

// ---------------------------------------------------------------------------
// 宿主插件
// ---------------------------------------------------------------------------

/**
 * 挂载宿主半边：起账本引擎、注册 `/api/dsh-daily-cost/summary`。
 * @param ctx - 宿主插件上下文。
 * @param rawConfig - `cordis.patch.yml` 里该行的 `config`（可省略）。
 */
export function apply(ctx, rawConfig) {
  const log = ctx?.logger
  const cfg = normalizeConfig(rawConfig, log)
  const state = {
    files: new Map(),
    lastScanAt: 0,
    lastScanMs: 0,
    lastError: null,
    running: false,
    queued: false,
    appliedAt: Date.now(),
    /** 浏览器取值路由的挂载情况：排障时直接从快照里看。 */
    route: { path: ROUTE_PATH, registered: false, error: null, at: null },
  }

  const snapshotPath = path.join(cfg.home, DATA_DIR, 'summary.json')

  /** 刷新一次账本：增量续读每个会话日志。 */
  async function refresh(reason) {
    if (state.running) {
      state.queued = true
      return
    }
    state.running = true
    const startedAt = Date.now()
    let changed = false
    try {
      const files = []
      for (const root of cfg.roots) await listSessionFiles(root, files, 0)
      const seen = new Set()
      for (const file of files) {
        let fileState = state.files.get(file)
        if (fileState === undefined) {
          fileState = newFileState()
          state.files.set(file, fileState)
        }
        seen.add(file)
        let read = await readRange(file, fileState.offset)
        if (read === null) continue
        if (read.size < fileState.offset) {
          // 文件被替换或截断：清空该文件的账，从 0 重折。
          fileState.offset = 0
          fileState.days = new Map()
          fileState.model = null
          fileState.carry = ''
          fileState.foldedEvents = 0
          fileState.frames = 0
          fileState.resets += 1
          read = await readRange(file, 0)
          if (read === null) continue
        }
        if (read.bytes.length === 0) continue
        const decoded = decodeAppended(read.bytes, true, (text) => foldText(fileState, text, cfg))
        if (decoded.consumed > 0) {
          fileState.offset += decoded.consumed
          fileState.skips += decoded.skips
          fileState.frames += decoded.frames
          changed = true
        }
      }
      // 文件消失（会话被删）时也把它的贡献去掉。
      for (const file of [...state.files.keys()]) {
        if (!seen.has(file)) {
          state.files.delete(file)
          changed = true
        }
      }
      state.lastScanAt = Date.now()
      state.lastScanMs = state.lastScanAt - startedAt
      state.lastError = null
      if ((changed || reason === 'start') && cfg.writeSummaryFile) await writeSnapshot()
      if (reason === 'start') {
        const summary = buildSummary(state, cfg, {})
        log?.info?.(
          `[dsh-daily-cost] 就绪：${summary.scan.files} 个会话日志 / ${summary.scan.foldedEvents} 次调用 / ` +
            `今日 ${cfg.currency} ${summary.today.cost}（${summary.today.calls} 次调用）`,
        )
      }
    } catch (error) {
      state.lastError = String(error?.message ?? error)
      log?.warn?.(`[dsh-daily-cost] 刷新失败：${state.lastError}`)
    } finally {
      state.running = false
      if (state.queued) {
        state.queued = false
        setTimeout(() => {
          void refresh('queued')
        }, 50)
      }
    }
  }

  /** 原子写快照（先写临时文件再改名），供外部读取与排查。 */
  async function writeSnapshot() {
    try {
      await fsp.mkdir(path.dirname(snapshotPath), { recursive: true })
      const summary = buildSummary(state, cfg, { days: cfg.defaultDays })
      const temp = `${snapshotPath}.tmp`
      await fsp.writeFile(temp, JSON.stringify(summary, null, 2), 'utf8')
      await fsp.rename(temp, snapshotPath)
    } catch (error) {
      log?.warn?.(`[dsh-daily-cost] 写快照失败：${String(error?.message ?? error)}`)
    }
  }

  // --- 引擎：首次全量 + watch 增量 + 兜底轮询 ------------------------------

  let debounce = null
  let watcher = null
  let timer = null

  const kick = (delay) => {
    if (debounce !== null) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      void refresh('watch')
    }, delay)
  }

  ctx.effect(() => {
    void refresh('start')
    try {
      watcher = fs.watch(cfg.roots[0], { recursive: true }, (_event, filename) => {
        const name = typeof filename === 'string' ? filename : ''
        if (name.length > 0 && !name.endsWith('.zstd')) return
        kick(1200)
      })
      watcher.on?.('error', (error) => {
        log?.warn?.(`[dsh-daily-cost] watch 出错，退回轮询：${String(error?.message ?? error)}`)
        try {
          watcher?.close()
        } catch {}
        watcher = null
      })
    } catch (error) {
      log?.warn?.(`[dsh-daily-cost] 无法 watch ${cfg.roots[0]}，退回轮询：${String(error?.message ?? error)}`)
      watcher = null
    }
    timer = setInterval(() => kick(0), cfg.refreshMs)
    timer.unref?.()
    return () => {
      if (debounce !== null) clearTimeout(debounce)
      if (timer !== null) clearInterval(timer)
      try {
        watcher?.close()
      } catch {}
      watcher = null
    }
  }, 'dsh-daily-cost: ledger engine')

  // --- 浏览器半边的取值接口 ------------------------------------------------

  /**
   * 取 connection 服务。
   *
   * 这里刻意用 `ctx.get(name)` 而不是 `ctx.connection`：后者在「服务不在本 fiber 的
   * 依赖里」的实现下可能抛错，而一次抛错会顺着 `ctx.effect` 冒到 `apply`，
   * 让 cordis 认为整个插件加载失败并**回收已经注册的 effect**（引擎会跟着停）。
   * 取值/注册的每一步都自己兜住，任何失败只记在 `state.route` 里。
   */
  const safeConnection = (scopeCtx) => {
    try {
      if (scopeCtx !== null && typeof scopeCtx.get === 'function') return scopeCtx.get('connection')
    } catch (error) {
      state.route.error = `ctx.get('connection') 抛错：${String(error?.message ?? error)}`
    }
    try {
      return scopeCtx?.connection
    } catch (error) {
      state.route.error = `ctx.connection 抛错：${String(error?.message ?? error)}`
      return undefined
    }
  }

  const registerRoute = (scopeCtx) => {
    const connection = safeConnection(scopeCtx)
    if (connection === undefined || connection === null) {
      state.route.error = "拿不到 connection 服务"
      log?.warn?.('[dsh-daily-cost] 拿不到 connection 服务，浏览器半边将拿不到数据')
      return undefined
    }
    if (typeof connection.fetch?.register !== 'function') {
      state.route.error = 'connection.fetch.register 不是函数'
      log?.warn?.('[dsh-daily-cost] connection.fetch.register 不可用，浏览器半边将拿不到数据')
      return undefined
    }
    try {
      const dispose = connection.fetch.register({
        path: ROUTE_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const url = new URL(request.url)
            const days = Number(url.searchParams.get('days'))
            const summary = buildSummary(state, cfg, { days: Number.isFinite(days) ? days : undefined })
            if (url.searchParams.get('refresh') === '1') {
              void refresh('request')
              summary.refreshing = true
            }
            return new Response(JSON.stringify(summary), {
              status: 200,
              headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
            })
          } catch (error) {
            return new Response(JSON.stringify({ ok: false, error: String(error?.message ?? error) }), {
              status: 500,
              headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
            })
          }
        },
      })
      state.route.registered = true
      state.route.error = null
      state.route.at = Date.now()
      return dispose
    } catch (error) {
      state.route.error = `register 抛错：${String(error?.message ?? error)}`
      log?.error?.(`[dsh-daily-cost] 注册 ${ROUTE_PATH} 失败：${state.route.error}`)
      return undefined
    }
  }

  ctx.effect(() => {
    let dispose
    const connection = safeConnection(ctx)
    if (connection !== undefined && connection !== null) {
      dispose = registerRoute(ctx)
    } else if (typeof ctx.inject === 'function') {
      // 服务可能晚于本插件就绪：等它出现再挂一次（回调里同样不抛）。
      try {
        ctx.inject(['connection'], (serviceCtx) => {
          dispose = registerRoute(serviceCtx)
        })
      } catch (error) {
        state.route.error = `ctx.inject 抛错：${String(error?.message ?? error)}`
      }
    }
    return () => {
      if (typeof dispose === 'function') {
        try {
          dispose()
        } catch {}
      }
    }
  }, 'dsh-daily-cost: summary route')

  // 路由状态先落一次盘：即使后面的刷新出问题，也能从快照看出 apply 走到哪一步。
  if (cfg.writeSummaryFile) void writeSnapshot()
}

export default apply
