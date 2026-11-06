/**
 * 把 dsh-daily-cost 这套插件登记进 DSH web profile：
 *   - dependencies['<pkg>'] = 'file:node_modules/<pkg>'
 *   - dsh.profile.bundles 末尾追加 '<pkg>'
 * 并清掉历史用过的旧包名（重命名时留下的），保持清单干净。
 *
 *   node patch-profile.cjs "<profile>/package.json" [pkg]
 */
const fs = require('node:fs')

const file = process.argv[2]
const pkg = process.argv[3] ?? 'dsh-daily-cost-host'
const LEGACY = ['dsh-daily-cost']
if (file === undefined) {
  console.error('usage: node patch-profile.cjs <profile>/package.json [pkg]')
  process.exit(2)
}

const before = fs.readFileSync(file, 'utf8')
const manifest = JSON.parse(before)

manifest.dependencies = manifest.dependencies ?? {}
for (const name of LEGACY) if (name !== pkg) delete manifest.dependencies[name]
manifest.dependencies[pkg] = `file:node_modules/${pkg}`

manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = manifest.dsh.profile ?? {}
const bundles = (manifest.dsh.profile.bundles ?? []).filter((name) => name !== pkg && !LEGACY.includes(name))
bundles.push(pkg)
manifest.dsh.profile.bundles = bundles

const after = `${JSON.stringify(manifest, null, 2)}\n`
if (after === before) {
  console.log('already patched, nothing to do')
} else {
  const backup = `${file}.bak-dailycost-${Date.now()}`
  fs.writeFileSync(backup, before, 'utf8')
  fs.writeFileSync(file, after, 'utf8')
  console.log(`patched (backup: ${backup})`)
}

const check = JSON.parse(fs.readFileSync(file, 'utf8'))
console.log(`dependencies.${pkg} =`, check.dependencies[pkg])
console.log('bundles =', check.dsh.profile.bundles.join(', '))
