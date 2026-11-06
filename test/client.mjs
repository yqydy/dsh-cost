/**
 * dsh-daily-cost 浏览器半边自检：
 *
 * 1. 在假 `window.__ModuleLoader__` 里执行 client.js，取出模块工厂；
 * 2. 用真 React（createElement）+ 假 hooks（把 useState 的初值换成我们给的状态）
 *    调 `apply()` 拿到注册进 dock 槽位的组件；
 * 3. 用真 react-dom/server 渲染成 HTML，检查两种语言、有无数据、出错三种情形下
 *    都能渲染出预期内容且不抛异常。
 *
 *   node test/client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const APP_NODE_MODULES = process.env.DSH_APP_MODULES ?? 'E:\\xiazai\\ykdsh\\DSH Desktop Plus\\resources\\app\\node_modules'
const requireFromApp = createRequire(path.join(APP_NODE_MODULES, 'index.cjs'))
const realReact = requireFromApp('react')
const { renderToStaticMarkup } = requireFromApp('react-dom/server')

const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')
/** 包名 = 客户端工厂 id（两者必须一致，否则 dsh-client-modules 拒绝加载）。 */
const PACKAGE_NAME = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).name

let failures = 0
const fail = (message) => {
  failures += 1
  console.error(`FAIL: ${message}`)
}
const ok = (condition, message) => {
  if (!condition) fail(message)
}

/** 用给定状态渲染一次，返回 HTML 与抛出的异常。 */
function render(states) {
  const captured = []
  const windowStub = { __ModuleLoader__: { load: (entry) => captured.push(entry) } }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'navigator', 'MutationObserver', source)(
    windowStub,
    { documentElement: { lang: states.lang }, visibilityState: 'visible' },
    { language: states.lang },
    class {
      observe() {}
      disconnect() {}
    },
  )
  if (captured.length !== 1) throw new Error('client.js 没有注册模块')
  const entry = captured[0]
  if (entry.id !== PACKAGE_NAME) throw new Error(`模块 id 不是包名：${entry.id} != ${PACKAGE_NAME}`)

  const queue = [...states.values]
  let index = 0
  const fakeReact = {
    ...realReact,
    useState: () => {
      const value = queue[index] ?? null
      index += 1
      return [value, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
  }

  const exports = entry.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`client.js 依赖了未声明的模块：${name}`)
  })
  if (typeof exports.apply !== 'function') throw new Error('模块没有导出 apply')
  if (!Array.isArray(exports.inject) || !exports.inject.includes('slots')) throw new Error('inject 没有声明 slots')

  let Component = null
  let injected = null
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (name, callback) => {
        injected = name
        return callback()
      },
      register: (options, component) => {
        ok(options.name === 'conversation.session.header.actions', `注册到了错误的槽位：${options.name}`)
        ok(options.id === 'daily-cost', `槽位条目 id 不对：${options.id}`)
        Component = component
      },
    },
  }
  exports.apply(ctx)
  ok(injected === 'conversation.session.header.actions', `inject 的槽位不对：${injected}`)
  if (Component === null) throw new Error('没有注册组件')

  return renderToStaticMarkup(realReact.createElement(Component))
}

// --- 样例数据（形状与宿主半边 buildSummary 的输出一致） --------------------

const SAMPLE = {
  ok: true,
  currency: 'CNY',
  generatedAt: Date.UTC(2026, 9, 10, 3, 30, 0),
  prices: { 'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 } },
  today: {
    date: '2026-10-10',
    calls: 846,
    tokens: { miss: 2574843, hit: 288974720, out: 825872, write: 0 },
    cost: 11.6578,
    costPeak: 0,
    costOffPeak: 11.6578,
    models: [],
  },
  days: [
    { date: '2026-10-10', cost: 11.6578, costPeak: 0, costOffPeak: 11.6578, calls: 846, tokens: { miss: 2574843, hit: 288974720, out: 825872 }, models: [] },
    { date: '2026-10-09', cost: 83.8174, costPeak: 70.3268, costOffPeak: 13.4907, calls: 2991, tokens: { miss: 11033325, hit: 1383392128, out: 2488222 }, models: [] },
    { date: '2026-10-08', cost: 49.1083, costPeak: 42.2487, costOffPeak: 6.8596, calls: 1863, tokens: { miss: 5662159, hit: 803564160, out: 1562629 }, models: [] },
  ],
  models: [
    { model: 'deepseek-flash', calls: 6644, cost: 171.1539, tokens: { miss: 23396099, hit: 2604786560, out: 6444660 }, priced: true },
    { model: 'some-unpriced-model', calls: 3, cost: 0, tokens: { miss: 100, hit: 0, out: 10 }, priced: false },
  ],
}

// --- 用例 -------------------------------------------------------------------

console.log('--- 情形 1：中文 + 已展开 + 有数据 ---')
{
  const html = render({ lang: 'zh-CN', values: ['zh', SAMPLE, null, true, false] })
  ok(html.includes('今日'), '缺少「今日」')
  ok(html.includes('¥11.66'), '没有显示今日金额')
  ok(html.includes('10-09'), '缺少逐日行')
  ok(html.includes('deepseek-flash'), '缺少模型行')
  ok(html.includes('未定价'), '未定价模型没有标注')
  ok(html.includes('缓存命中率'), '缺少缓存命中率')
  ok(html.includes('99.1%'), '缓存命中率数值不对')
  ok(html.includes('09:00-12:00'), '缺少时段规则说明')
  console.log(html.slice(0, 260).replace(/\s+/g, ' '))
}

console.log('\n--- 情形 2：英文 + 收起（只有胶囊） ---')
{
  const html = render({ lang: 'en-US', values: ['en', SAMPLE, null, false, false] })
  ok(html.includes('Today'), '缺少 Today')
  ok(html.includes('¥11.66'), '没有显示今日金额')
  ok(!html.includes('Last 7 days'), '收起时不应渲染面板')
  console.log(html.replace(/\s+/g, ' '))
}

console.log('\n--- 情形 3：宿主还没就绪（data=null，无错误） ---')
{
  const html = render({ lang: 'zh-CN', values: ['zh', null, null, false, true] })
  ok(html.includes('¥0.00'), '缺少兜底金额')
  console.log(html.replace(/\s+/g, ' '))
}

console.log('\n--- 情形 4：出错 + 展开 ---')
{
  const html = render({ lang: 'zh-CN', values: ['zh', null, 'HTTP 401', true, false] })
  ok(html.includes('HTTP 401'), '没有把错误显示出来')
  ok(html.includes('读取失败'), '缺少错误标题')
  console.log(html.slice(0, 200).replace(/\s+/g, ' '))
}

console.log('\n--- 情形 5：空语言回退 ---')
{
  const html = render({ lang: '', values: ['zh', SAMPLE, null, false, false] })
  ok(html.length > 0, '空语言渲染失败')
}

if (failures === 0) console.log('\nOK：浏览器半边在 5 种情形下都正常渲染')
else console.error(`\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
