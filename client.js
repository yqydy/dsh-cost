/**
 * dsh-daily-cost — 浏览器半边。
 *
 * 在**会话标题栏**（顶部）的 actions 区挂一个费用胶囊：平时只显示「今日 ¥x.xx」，
 * 点一下在其下方弹出一个**绝对定位浮层**（不占布局、不推动输入框），里面是明细：
 * 今天的分项、高峰/空闲拆分、近 7 天、按模型、以及价格来源与时段规则。
 * 点别处或按 Esc 收起。
 *
 * 数据来自宿主半边的 `GET /api/dsh-daily-cost/summary`（同源、带 Connection 的
 * cookie）。宿主用 `fs.watch` 增量折会话日志，这里按固定间隔轮询即可实时反映。
 *
 * 约定：不依赖任何 Harness Client 包（除了由宿主注入的 `slots` 服务本身），
 * 只 `require('react')` / `require('react-dom')`（后者仅用于把浮层 portal 出裁剪容器）；
 * 所有样式走 `--dsw-alias-*` 宿主主题令牌；文案按 `<html lang>` 在中文/英文之间切换。
 *
 * 浮层为什么走 portal：DSH 0.2.2 起，会话标题栏把标题与 actions 包进
 * `.titleCluster`，该元素带 `overflow: clip` + `mask-image`（标题左端渐隐）。
 * 祖先的 clip 会连同 `position: absolute` 甚至 `position: fixed` 的后代一起裁掉，
 * 留在里面的浮层永远不可见（表现就是「点花费没反应」）。因此浮层必须 portal 到
 * `document.body` 并用 `position: fixed` 按胶囊的 `getBoundingClientRect()` 定位。
 *
 * @module dsh-daily-cost/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-daily-cost-host',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    /** react-dom 是客户端模块的平台 seed（宿主直接提供），这里只取 createPortal。 */
    const ReactDOM = (() => {
      try {
        return require('react-dom')
      } catch {
        return null
      }
    })()
    const createPortal = typeof ReactDOM?.createPortal === 'function' ? ReactDOM.createPortal : null

    /** 取值端点（宿主半边注册的精确 Fetch 路由）。 */
    const ENDPOINT = '/api/dsh-daily-cost/summary'
    /** 挂载槽位：会话标题栏右侧的 actions 区（顶部）。 */
    const SLOT = 'conversation.session.header.actions'
    /** 槽位内的条目 id（只要求在该槽位里唯一，与包名解耦）。 */
    const ENTRY_ID = 'daily-cost'
    /** 轮询间隔：宿主侧已有 watch，这里只是把新结果取回来。 */
    const POLL_MS = 15000
    /** 浮层层级：高于宿主菜单/浮层（这些通常 portal 到 body 且带 z-index）。 */
    const PANEL_Z_INDEX = 2147483000
    /** 浮层与胶囊的间距（px）。 */
    const GAP_PX = 6
    /** 浮层最大高度（px），实际还会被视口高度进一步压缩。 */
    const MAX_HEIGHT_PX = 440

    // ---------------------------------------------------------------------
    // 文案
    // ---------------------------------------------------------------------

    const TEXT = {
      zh: {
        title: 'DeepSeek 费用',
        today: '今日',
        calls: '调用',
        inMiss: '未命中输入',
        inHit: '命中输入',
        out: '输出',
        cacheRate: '缓存命中率',
        peakShort: '高峰',
        offPeakShort: '空闲',
        last7: '近 7 天',
        byModel: '按模型',
        refresh: '刷新',
        collapse: '收起',
        updated: '更新于',
        loading: '读取中…',
        unavailable: '读取失败',
        retry: '重试',
        noData: '暂无用量',
        unpriced: '未定价',
        priceNote: '价格：DeepSeek 官网（元/百万 tokens，高峰价）',
        peakNote: '高峰：北京时间周一至周五 09:00-12:00、14:00-18:00（法定节假日除外），其余为空闲且按半价。',
        windowNote: '统计口径：本机全部会话日志（含子代理），按北京时间分日。',
        cost: '费用',
      },
      en: {
        title: 'DeepSeek cost',
        today: 'Today',
        calls: 'Calls',
        inMiss: 'Input (miss)',
        inHit: 'Input (hit)',
        out: 'Output',
        cacheRate: 'Cache hit rate',
        peakShort: 'Peak',
        offPeakShort: 'Off-peak',
        last7: 'Last 7 days',
        byModel: 'By model',
        refresh: 'Refresh',
        collapse: 'Collapse',
        updated: 'Updated',
        loading: 'Loading…',
        unavailable: 'Unavailable',
        retry: 'Retry',
        noData: 'No usage yet',
        unpriced: 'unpriced',
        priceNote: 'Prices: DeepSeek official list (per 1M tokens, peak rate)',
        peakNote: 'Peak: Mon-Fri 09:00-12:00 & 14:00-18:00 Beijing time (excl. statutory holidays); all other times are off-peak at half price.',
        windowNote: 'Scope: every local session log (subagents included), grouped by Beijing date.',
        cost: 'Cost',
      },
    }

    function detectLang() {
      try {
        const lang = document.documentElement?.lang ?? ''
        if (/^zh/i.test(lang)) return 'zh'
        const nav = navigator.language ?? ''
        return /^zh/i.test(nav) ? 'zh' : 'en'
      } catch {
        return 'zh'
      }
    }

    // ---------------------------------------------------------------------
    // 格式化
    // ---------------------------------------------------------------------

    const CURRENCY_SYMBOL = { CNY: '¥', USD: '$' }

    function money(value, currency) {
      const symbol = CURRENCY_SYMBOL[currency] ?? ''
      const number = Number(value ?? 0)
      if (!Number.isFinite(number)) return `${symbol}0.00`
      if (number === 0) return `${symbol}0.00`
      if (number < 0.01) return `${symbol}${number.toFixed(4)}`
      if (number < 100) return `${symbol}${number.toFixed(2)}`
      return `${symbol}${number.toFixed(1)}`
    }

    function tokens(value) {
      const number = Number(value ?? 0)
      if (!Number.isFinite(number) || number === 0) return '0'
      if (number >= 1e9) return `${(number / 1e9).toFixed(2)}B`
      if (number >= 1e6) return `${(number / 1e6).toFixed(2)}M`
      if (number >= 1e3) return `${(number / 1e3).toFixed(1)}K`
      return String(number)
    }

    function clock(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }

    /** 7 天里最贵的一天，用来给柱状条定标。 */
    function maxCost(days) {
      let max = 0
      for (const day of days) max = Math.max(max, Number(day.cost ?? 0))
      return max
    }

    // ---------------------------------------------------------------------
    // 样式（全部走宿主主题令牌，带兜底值）
    // ---------------------------------------------------------------------

    const S = {
      wrap: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        height: '22px',
        padding: '0 7px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
        fontSize: '11px',
        lineHeight: '18px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      },
      dot: { width: '6px', height: '6px', borderRadius: '999px', background: 'var(--dsw-alias-state-business-primary, #2f6fed)', flex: 'none' },
      amount: { fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary, #6b6b6b)' },
      /** 兜底样式：没有 react-dom 时退回「留在槽位里」的旧行为（0.2.2 会被裁剪）。 */
      panel: {
        position: 'absolute',
        top: `calc(100% + ${GAP_PX}px)`,
        right: '0',
        zIndex: 100,
        boxSizing: 'border-box',
        width: 'min(400px, calc(100vw - 32px))',
        maxHeight: `min(${MAX_HEIGHT_PX}px, calc(100vh - 140px))`,
        overflowY: 'auto',
        padding: '10px 12px',
        border: '0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12))',
        borderRadius: 'var(--dsw-radius-lg, 10px)',
        background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-base, #fff))',
        boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,.16))',
        backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
        color: 'var(--dsw-alias-label-primary, #1a1a1a)',
        fontSize: '12px',
        lineHeight: '18px',
        textAlign: 'left',
      },
      headRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' },
      headTitle: { fontSize: '12px', fontWeight: 600 },
      headMeta: { color: 'var(--dsw-alias-label-tertiary, #8b8b8b)', fontSize: '11px', fontVariantNumeric: 'tabular-nums' },
      bigRow: { display: 'flex', alignItems: 'baseline', gap: '8px', margin: '2px 0 6px' },
      big: { fontSize: '22px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      bigNote: { color: 'var(--dsw-alias-label-tertiary, #8b8b8b)', fontSize: '11px' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '4px 12px', margin: '4px 0 8px' },
      kvRow: { display: 'flex', justifyContent: 'space-between', gap: '8px' },
      kvKey: { color: 'var(--dsw-alias-label-tertiary, #8b8b8b)' },
      kvVal: { fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', fontSize: '11px' },
      sectionTitle: {
        marginTop: '8px',
        marginBottom: '4px',
        color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
        fontSize: '11px',
      },
      dayRow: { display: 'grid', gridTemplateColumns: '74px 1fr 62px', alignItems: 'center', gap: '8px', marginBottom: '2px' },
      dayLabel: { fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary, #6b6b6b)' },
      barTrack: { height: '6px', borderRadius: '999px', background: 'var(--dsw-alias-fill-l2, rgba(0,0,0,.06))', overflow: 'hidden' },
      barPeak: { height: '100%', background: 'var(--dsw-alias-state-business-primary, #2f6fed)', borderRadius: '999px 0 0 999px' },
      barOff: { height: '100%', background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #2f6fed) 45%, transparent)' },
      dayCost: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '11px' },
      th: { textAlign: 'left', color: 'var(--dsw-alias-label-tertiary, #8b8b8b)', fontWeight: 400, padding: '2px 6px 2px 0' },
      thRight: { textAlign: 'right', color: 'var(--dsw-alias-label-tertiary, #8b8b8b)', fontWeight: 400, padding: '2px 0' },
      td: { padding: '2px 6px 2px 0', fontVariantNumeric: 'tabular-nums' },
      tdRight: { padding: '2px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
      note: { marginTop: '8px', color: 'var(--dsw-alias-label-tertiary, #8b8b8b)', fontSize: '10px', lineHeight: '15px' },
      action: {
        border: '0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-base, #fff))',
        color: 'var(--dsw-alias-label-secondary, #6b6b6b)',
        height: '20px',
        padding: '0 7px',
        fontSize: '11px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      error: { color: 'var(--dsw-alias-state-error-primary, #d33)', fontSize: '11px' },
    }

    // ---------------------------------------------------------------------
    // 组件
    // ---------------------------------------------------------------------

    /**
     * 费用胶囊 + 展开面板。
     * @param props - slot 传入的 props；本组件不依赖其中任何字段。
     */
    function DailyCost() {
      const [lang, setLang] = React.useState(detectLang)
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      /** 胶囊在视口里的位置（portal 出去的浮层按它定位）。 */
      const [anchor, setAnchor] = React.useState(null)
      const rootRef = React.useRef(null)
      const pillRef = React.useRef(null)
      const panelRef = React.useRef(null)

      const t = TEXT[lang] ?? TEXT.zh

      const load = React.useCallback(async (force) => {
        setBusy(true)
        try {
          const response = await fetch(`${ENDPOINT}${force ? '?refresh=1' : ''}`, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const json = await response.json()
          if (json?.ok !== true) throw new Error(json?.error ?? 'bad payload')
          setData(json)
          setError(null)
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => {
        let cancelled = false
        // 首次一定取：右侧面板里的页面可能一直被浏览器判定为 hidden，
        // 若把首取也挂在可见性上，胶囊会永远停在初始值。
        void load(false)
        const timer = window.setInterval(() => {
          if (cancelled) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void load(false)
        }, POLL_MS)
        const onLang = () => setLang(detectLang())
        try {
          const observer = new MutationObserver(onLang)
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
          return () => {
            cancelled = true
            window.clearInterval(timer)
            observer.disconnect()
          }
        } catch {
          return () => {
            cancelled = true
            window.clearInterval(timer)
          }
        }
      }, [load])

      const currency = data?.currency ?? 'CNY'
      const today = data?.today
      const days = Array.isArray(data?.days) ? data.days.slice(0, 7) : []
      const scale = maxCost(days)
      const pillLabel = error !== null && data === null ? '—' : money(today?.cost ?? 0, currency)

      /** 量一次胶囊位置；浮层用 fixed 定位，所以滚动/缩放后要重新量。 */
      const measure = React.useCallback(() => {
        const node = pillRef.current
        if (node === null || typeof node.getBoundingClientRect !== 'function') return
        const rect = node.getBoundingClientRect()
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight
        const panelWidth = Math.min(400, viewportWidth - 32)
        // 右对齐胶囊，同时把浮层夹在视口内，避免窄窗口下被挤出屏幕。
        const right = Math.min(
          Math.max(8, Math.round(viewportWidth - rect.right)),
          Math.max(8, Math.round(viewportWidth - panelWidth - 8)),
        )
        const top = Math.max(8, Math.min(Math.round(rect.bottom + GAP_PX), viewportHeight - 160))
        setAnchor((previous) => (previous !== null
          && previous.top === top
          && previous.right === right
          ? previous
          : { top, right }))
      }, [])

      // 打开时先量位置（layout effect，赶在第一帧绘制前），并在滚动/缩放时保持贴住胶囊。
      React.useLayoutEffect(() => {
        if (!open) return undefined
        measure()
        const onLayout = () => measure()
        window.addEventListener('resize', onLayout)
        window.addEventListener('scroll', onLayout, true)
        return () => {
          window.removeEventListener('resize', onLayout)
          window.removeEventListener('scroll', onLayout, true)
        }
      }, [open, measure])

      // 点开时：点别处 / 按 Esc 收起。浮层不占布局，所以这层收尾是必要的。
      // 注意：浮层 portal 到了 body，不在 root 里，判断「外面」时要把浮层也算进来。
      React.useEffect(() => {
        if (!open) return undefined
        const inside = (node, target) => node !== null && typeof node.contains === 'function' && node.contains(target)
        const onPointerDown = (event) => {
          const target = event.target
          if (inside(rootRef.current, target)) return
          if (inside(panelRef.current, target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      const children = []

      children.push(
        h(
          'button',
          {
            key: 'pill',
            ref: pillRef,
            type: 'button',
            style: S.pill,
            title: `${t.title} · ${t.today} ${pillLabel}`,
            'aria-expanded': open,
            onClick: () => {
              const next = !open
              if (next) measure()
              setOpen(next)
              if (next) void load(true)
            },
          },
          h('span', { style: { ...S.dot, background: error !== null ? 'var(--dsw-alias-state-error-primary, #d33)' : S.dot.background } }),
          h('span', null, t.today),
          h('span', { style: S.amount }, busy && data === null ? t.loading : pillLabel),
        ),
      )

      if (open) {
        const panel = []

        panel.push(
          h(
            'div',
            { key: 'head', style: S.headRow },
            h('span', { style: S.headTitle }, t.title),
            h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
              h('span', { style: S.headMeta }, `${t.updated} ${clock(data?.generatedAt)}`),
              h(
                'button',
                {
                  type: 'button',
                  style: S.action,
                  onClick: () => void load(true),
                  disabled: busy,
                },
                t.refresh,
              ),
              h('button', { type: 'button', style: S.action, onClick: () => setOpen(false) }, t.collapse),
            ),
          ),
        )

        if (error !== null) {
          panel.push(h('div', { key: 'err', style: S.error }, `${t.unavailable}：${error}`))
        }

        if (data !== null) {
          panel.push(
            h(
              'div',
              { key: 'big', style: S.bigRow },
              h('span', { style: S.big }, money(today?.cost ?? 0, currency)),
              h('span', { style: S.bigNote }, `${t.today} · ${t.calls} ${today?.calls ?? 0}`),
            ),
          )

          const tokensToday = today?.tokens ?? { miss: 0, hit: 0, out: 0 }
          const hitRate = (tokensToday.miss ?? 0) + (tokensToday.hit ?? 0) > 0
            ? ((tokensToday.hit ?? 0) / ((tokensToday.miss ?? 0) + (tokensToday.hit ?? 0))) * 100
            : 0

          panel.push(
            h(
              'div',
              { key: 'grid', style: S.grid },
              kv(t.inMiss, tokens(tokensToday.miss)),
              kv(t.inHit, tokens(tokensToday.hit)),
              kv(t.out, tokens(tokensToday.out)),
              kv(t.cacheRate, `${hitRate.toFixed(1)}%`),
              kv(t.peakShort, money(today?.costPeak ?? 0, currency)),
              kv(t.offPeakShort, money(today?.costOffPeak ?? 0, currency)),
            ),
          )

          panel.push(h('div', { key: 's7', style: S.sectionTitle }, t.last7))
          if (days.length === 0) {
            panel.push(h('div', { key: 's7empty', style: S.kvKey }, t.noData))
          }
          for (const day of days) {
            const cost = Number(day.cost ?? 0)
            const width = scale > 0 ? Math.max(2, (cost / scale) * 100) : 0
            const peakShare = cost > 0 ? Math.min(100, Math.max(0, (Number(day.costPeak ?? 0) / cost) * 100)) : 0
            panel.push(
              h(
                'div',
                { key: `d-${day.date}`, style: S.dayRow, title: `${t.peakShort} ${money(day.costPeak, currency)} / ${t.offPeakShort} ${money(day.costOffPeak, currency)}` },
                h('span', { style: S.dayLabel }, day.date.slice(5)),
                h(
                  'span',
                  { style: S.barTrack },
                  h('span', {
                    style: {
                      display: 'flex',
                      width: `${width}%`,
                      height: '100%',
                      borderRadius: '999px',
                      overflow: 'hidden',
                    },
                  },
                    h('span', { style: { ...S.barPeak, width: `${peakShare}%` } }),
                    h('span', { style: { ...S.barOff, width: `${100 - peakShare}%` } }),
                  ),
                ),
                h('span', { style: S.dayCost }, money(cost, currency)),
              ),
            )
          }

          const models = Array.isArray(data.models) ? data.models : []
          if (models.length > 0) {
            panel.push(h('div', { key: 'sm', style: S.sectionTitle }, t.byModel))
            const rows = [
              h(
                'tr',
                { key: 'h' },
                h('th', { style: S.th }, 'model'),
                h('th', { style: S.thRight }, t.calls),
                h('th', { style: S.thRight }, t.inMiss),
                h('th', { style: S.thRight }, t.inHit),
                h('th', { style: S.thRight }, t.out),
                h('th', { style: S.thRight }, t.cost),
              ),
            ]
            for (const model of models) {
              rows.push(
                h(
                  'tr',
                  { key: model.model },
                  h('td', { style: S.td }, model.model, model.priced === false ? h('span', { style: S.kvKey }, ` (${t.unpriced})`) : null),
                  h('td', { style: S.tdRight }, model.calls),
                  h('td', { style: S.tdRight }, tokens(model.tokens?.miss)),
                  h('td', { style: S.tdRight }, tokens(model.tokens?.hit)),
                  h('td', { style: S.tdRight }, tokens(model.tokens?.out)),
                  h('td', { style: S.tdRight }, money(model.cost, currency)),
                ),
              )
            }
            panel.push(h('table', { key: 'tm', style: S.table }, h('tbody', null, rows)))
          }

          panel.push(
            h(
              'div',
              { key: 'note', style: S.note },
              h('div', null, `${t.priceNote}：${Object.entries(data.prices ?? {})
                .map(([model, price]) => `${model} hit ${price.cacheHit} / miss ${price.cacheMiss} / out ${price.output}`)
                .join(' · ')}`),
              h('div', null, t.peakNote),
              h('div', null, t.windowNote),
            ),
          )
        }

        /**
         * 浮层的两种落点：
         * - 有 react-dom：portal 到 body + fixed 定位（绕开标题栏的 overflow: clip /
         *   mask-image，这也是 0.2.2 起唯一能显示的方式）；
         * - 没有 react-dom：退回旧的内联 absolute（新版本会被裁剪，仅作兜底）。
         */
        const panelStyle = createPortal !== null
          ? {
              ...S.panel,
              position: 'fixed',
              top: `${anchor?.top ?? 0}px`,
              right: `${anchor?.right ?? 0}px`,
              left: 'auto',
              zIndex: PANEL_Z_INDEX,
              maxHeight: anchor === null
                ? `min(${MAX_HEIGHT_PX}px, calc(100vh - 140px))`
                : `min(${MAX_HEIGHT_PX}px, ${Math.max(160, window.innerHeight - anchor.top - 12)}px)`,
            }
          : S.panel
        const panelNode = h('div', { key: 'panel', ref: panelRef, style: panelStyle }, panel)
        // portal 在 children 数组里也要有 key，否则 React 会告警（第三参数就是 portal 的 key）。
        children.push(createPortal !== null ? createPortal(panelNode, document.body, 'panel') : panelNode)
      }

      return h('div', { style: S.wrap, ref: rootRef }, children)
    }

    /** 一行「标签 + 等宽数值」。 */
    function kv(key, value) {
      return h('div', { key, style: S.kvRow }, h('span', { style: S.kvKey }, key), h('span', { style: S.kvVal }, value))
    }

    // ---------------------------------------------------------------------
    // 挂载
    // ---------------------------------------------------------------------

    const inject = ['slots']

    /**
     * 把费用胶囊注册到会话标题栏（顶部）的 actions 槽位。
     *
     * 槽位选型：`conversation.session.header.actions`（kind=list、scope=session）
     * 就在会话标题与 token 统计那一行，属于顶部区域且不占用输入框下方的布局；
     * 展开的明细是 **portal 到 body 的 fixed 浮层**，点开也不推动任何东西。
     *
     * 去重：客户端模块图变更时，宿主会（按设计）继续保留**上一批** bundle 以照顾
     * 已经打开的页面，两批若都注册同一个槽位就会出现两个胶囊。这里在文档级记一份
     * 上一次的注册撤销函数，新的注册进来先把旧撤掉，保证一个文档里只有一个。
     * @param ctx - Client 插件上下文。
     */
    function apply(ctx) {
      const previous = globalThis.__dshDailyCostSlot
      if (typeof previous === 'function') {
        try {
          previous()
        } catch {}
        globalThis.__dshDailyCostSlot = undefined
      }
      const injected = ctx.slots.inject(SLOT, () =>
        ctx.slots.register({ name: SLOT, id: ENTRY_ID, order: 20 }, DailyCost),
      )
      globalThis.__dshDailyCostSlot = typeof injected === 'function' ? injected : undefined
      ctx.effect(() => injected, 'daily-cost: session header entry')
      ctx.effect(
        () => () => {
          if (globalThis.__dshDailyCostSlot === injected) globalThis.__dshDailyCostSlot = undefined
        },
        'daily-cost: session header entry bookkeeping',
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
