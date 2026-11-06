/**
 * dsh-daily-cost — 包根入口（薄转发）。
 *
 * 真正的宿主半边在 `./host.js`。之所以分成两个文件：Node 按 URL 缓存 ES 模块，
 * 已经加载过的包根入口在进程内不会因为文件改动而重新求值；把实现放在新入口
 * `./host.js`（由 `cordis.patch.yml` 以子路径 `dsh-daily-cost/host` 装载）就能
 * 在不重启应用的情况下让改动生效。
 *
 * 保留包根入口是为了兼容直接按包名装载的写法。
 *
 * @module dsh-daily-cost
 */
export { apply } from './host.js'
export { default } from './host.js'
