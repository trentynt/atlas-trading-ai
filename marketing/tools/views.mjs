// usage: node views.mjs OUTDIR WIDTH HEIGHT [views,comma] [fullpage 0|1]
import { chromium } from 'playwright'
const [out, W = '1600', H = '1000', only = '', full = '1'] = process.argv.slice(2)
const all = ['command','markets','research','strategy','forecast','portfolio','risk','experiments','telemetry']
const views = only ? only.split(',') : all
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: +W, height: +H }, deviceScaleFactor: 1 })
const problems = []
p.on('pageerror', e => problems.push('pageerror ' + e.message.slice(0, 200)))
p.on('console', m => { if (m.type() === 'error') problems.push('console ' + m.text().slice(0, 200)) })
p.on('response', r => { if (r.status() >= 400) problems.push(`http ${r.status()} ${r.url()}`) })
await p.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' })
for (const v of views) {
  const n = problems.length
  await p.evaluate(h => { location.hash = h }, v)
  await p.waitForTimeout(700); await p.waitForLoadState('networkidle'); await p.waitForTimeout(900)
  const overflowX = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1 || [...document.querySelectorAll('main *')].some(e => e.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('.overflow-x-auto,.overflow-auto')))
  if (full === '1') {
    const h = await p.evaluate(() => { const m = document.querySelector('main'); return m.scrollHeight + m.getBoundingClientRect().top + 8 })
    await p.setViewportSize({ width: +W, height: Math.min(9000, Math.max(+H, Math.ceil(h))) })
    await p.waitForTimeout(900)
  }
  await p.screenshot({ path: `${out}/${v}-${W}.png` })
  if (full === '1') { await p.setViewportSize({ width: +W, height: +H }); await p.waitForTimeout(200) }
  console.log(v.padEnd(12), 'overflowX', overflowX, 'problems', problems.length - n)
}
problems.forEach(x => console.log('  ' + x))
await b.close()
