// SIGNAL marketing capture — genuine product states only.
// usage: node market.mjs OUTDIR [shots|video|all]
import { chromium } from 'playwright'
import fs from 'node:fs'
const OUT = process.argv[2]
const MODE = process.argv[3] ?? 'all'
const ONLY = process.argv[4] ? process.argv[4].split(',') : null
const URL = 'http://127.0.0.1:5173/'
fs.mkdirSync(`${OUT}/screenshots`, { recursive: true })
fs.mkdirSync(`${OUT}/recordings/raw`, { recursive: true })
const browser = await chromium.launch()

// Soft cursor overlay so viewers can follow the interaction (recordings only).
const CURSOR = `(() => { const d = document.createElement('div'); d.id='__cur';
  d.style.cssText='position:fixed;z-index:99999;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(255,255,255,.92);box-shadow:0 0 0 6px rgba(94,234,212,.18),0 2px 10px rgba(0,0,0,.6);pointer-events:none;transition:transform .12s ease, width .15s, height .15s';
  const add=()=>document.body&&!document.getElementById('__cur')&&document.body.appendChild(d);
  document.addEventListener('DOMContentLoaded',add); add();
  addEventListener('mousemove',e=>{d.style.left=e.clientX+'px';d.style.top=e.clientY+'px'},true);
  addEventListener('mousedown',()=>d.style.transform='scale(.7)',true); addEventListener('mouseup',()=>d.style.transform='',true); })()`

const scrollMain = (p, to, ms = 1400) => p.evaluate(([to, ms]) => new Promise((res) => {
  const m = document.querySelector('main'); const from = m.scrollTop; const t0 = performance.now()
  const target = to === 'end' ? m.scrollHeight - m.clientHeight : to
  const step = (t) => { const k = Math.min(1, (t - t0) / ms); const e = k < .5 ? 2*k*k : 1 - Math.pow(-2*k+2, 2)/2; m.scrollTop = from + (target - from) * e; k < 1 ? requestAnimationFrame(step) : res() }
  requestAnimationFrame(step)
}), [to, ms])
const glide = async (p, x, y, steps = 30) => p.mouse.move(x, y, { steps })
const go = async (p, hash) => { await p.evaluate((h) => { location.hash = h }, hash); await p.waitForLoadState('networkidle'); await p.waitForTimeout(900) }

if (MODE === 'shots' || MODE === 'all') {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
  const p = await ctx.newPage()
  await p.goto(URL + '#overview', { waitUntil: 'networkidle' }); await p.waitForTimeout(3500)
  const shot = async (name, opts = {}) => { await p.screenshot({ path: `${OUT}/screenshots/${name}.png`, ...opts }); console.log('shot', name) }
  await shot('01-overview')
  await p.locator('canvas[role=img]').locator('xpath=ancestor::section[1]').screenshot({ path: `${OUT}/screenshots/07-computation-sphere.png` }); console.log('shot 07-computation-sphere')
  await go(p, 'markets?sym=BTC-USD'); await p.waitForTimeout(1500); await shot('02-markets')
  await go(p, 'research'); await shot('03-research')
  await go(p, 'strategies?sym=ETH-USD&strategy=donchian_breakout')
  await p.getByRole('button', { name: 'Run backtest' }).first().click(); await p.getByText(/Starting with/).waitFor({ timeout: 30000 })
  await p.getByRole('button', { name: 'Validate on unseen data' }).click(); await p.getByText('Evidence checks').waitFor({ timeout: 60000 })
  await scrollMain(p, 0, 10); await p.waitForTimeout(700); await shot('04-strategy-backtest')
  await p.locator('#validation').scrollIntoViewIfNeeded(); await p.waitForTimeout(900); await p.locator('#validation').screenshot({ path: `${OUT}/screenshots/04b-strategy-validation.png` }); console.log('shot 04b-strategy-validation')
  await go(p, 'portfolio'); await shot('05-portfolio')
  await go(p, 'risk'); await shot('06-risk')
  await go(p, 'discoveries'); await p.waitForTimeout(1200); await shot('08-discoveries')
  await go(p, 'forecasts?sym=EUR-USD'); await p.getByText('What this says').waitFor({ timeout: 20000 }); await p.waitForTimeout(800); await shot('09-forecasts')
  await ctx.close()
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
  const mp = await m.newPage(); await mp.goto(URL + '#overview', { waitUntil: 'networkidle' }); await mp.waitForTimeout(3000)
  await mp.screenshot({ path: `${OUT}/screenshots/10-mobile-overview.png` }); console.log('shot 10-mobile-overview')
  await m.close()
}

if (MODE === 'video' || MODE === 'all') {
  const clip = async (name, fn) => {
    if (ONLY && !ONLY.includes(name)) return
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: `${OUT}/recordings/raw`, size: { width: 1920, height: 1080 } } })
    await ctx.addInitScript(CURSOR)
    const p = await ctx.newPage()
    await p.mouse.move(960, 540)
    try { await fn(p) } catch (e) { console.log('clip error', name, e.message.split('\n')[0]) }
    const v = p.video(); await ctx.close()
    fs.renameSync(await v.path(), `${OUT}/recordings/raw/${name}.webm`); console.log('clip', name)
  }

  await clip('01-opening-signal', async (p) => {
    await p.goto(URL + '#overview', { waitUntil: 'networkidle' }); await p.waitForTimeout(4500)
    await glide(p, 1500, 220, 40); await p.waitForTimeout(800)
    await scrollMain(p, 760, 2600); await p.waitForTimeout(1600)
    await scrollMain(p, 1500, 2600); await p.waitForTimeout(1600)
    await scrollMain(p, 0, 2200); await p.waitForTimeout(1500)
  })

  await clip('02-research-workspace', async (p) => {
    await p.goto(URL + '#overview', { waitUntil: 'networkidle' }); await p.waitForTimeout(1200)
    const nav = p.getByRole('button', { name: 'Research', exact: true }); const b = await nav.boundingBox()
    await glide(p, b.x + 60, b.y + b.height / 2); await nav.click(); await p.waitForTimeout(1800)
    const card = p.getByRole('button', { name: /Research Critic/ }).first(); const cb = await card.boundingBox()
    await scrollMain(p, 300, 1500); await p.waitForTimeout(600)
    const cb2 = await card.boundingBox(); await glide(p, cb2.x + 120, cb2.y + 60); await p.waitForTimeout(500); await card.click(); await p.waitForTimeout(2600)
    await p.keyboard.press('Escape'); await p.waitForTimeout(800)
    await scrollMain(p, 'end', 2800); await p.waitForTimeout(1500)
    void cb
  })

  await clip('03-run-research-cycle', async (p) => {
    await p.goto(URL + '#research', { waitUntil: 'networkidle' }); await p.waitForTimeout(1500)
    const run = p.getByRole('button', { name: 'Run research cycle' }); const rb = await run.boundingBox()
    await glide(p, rb.x + rb.width / 2, rb.y + rb.height / 2, 35); await p.waitForTimeout(400)
    await run.click()
    await p.getByText('Running', { exact: true }).first().waitFor({ timeout: 15000 })
    await glide(p, 1400, 700, 40)
    await p.getByText('Running', { exact: true }).first().waitFor({ state: 'detached', timeout: 120000 }) // cycle finished
    await p.waitForTimeout(2000)
    await scrollMain(p, 900, 2400); await p.waitForTimeout(3000)
  })

  await clip('04-strategy-validation', async (p) => {
    await p.goto(URL + '#strategies?sym=ETH-USD&strategy=donchian_breakout', { waitUntil: 'networkidle' }); await p.waitForTimeout(1500)
    const card = p.getByRole('button', { name: /Channel breakout/ }).first(); const c = await card.boundingBox()
    await glide(p, c.x + 100, c.y + 40); await card.click(); await p.waitForTimeout(600)
    const run = p.getByRole('button', { name: 'Run backtest' }).first(); const r = await run.boundingBox()
    await glide(p, r.x + r.width / 2, r.y + r.height / 2); await run.click()
    await p.getByText(/Starting with/).waitFor({ timeout: 30000 }); await p.waitForTimeout(2500)
    await glide(p, 1300, 600, 30); await p.waitForTimeout(1500)
    const val = p.getByRole('button', { name: 'Validate on unseen data' }); const vb = await val.boundingBox()
    await glide(p, vb.x + vb.width / 2, vb.y + vb.height / 2); await val.click()
    await p.getByText('Evidence checks').waitFor({ timeout: 60000 }); await p.waitForTimeout(3500)
    await scrollMain(p, 'end', 2200); await p.waitForTimeout(2000)
  })

  await clip('05-computation-sphere', async (p) => {
    await p.goto(URL + '#overview', { waitUntil: 'networkidle' }); await p.waitForTimeout(3000)
    const c = await p.locator('canvas[role=img]').boundingBox()
    const cx = c.x + c.width / 2, cy = c.y + c.height / 2
    await glide(p, cx - 160, cy, 30); await p.mouse.down(); await glide(p, cx + 180, cy + 40, 60); await p.mouse.up(); await p.waitForTimeout(2200)
    await p.mouse.down(); await glide(p, cx - 60, cy - 120, 50); await p.mouse.up(); await p.waitForTimeout(2200)
    for (const [dx, dy] of [[0, 0], [0, -22], [0, 22], [-40, 0], [40, 0], [60, -60]]) {
      await glide(p, cx + dx, cy + dy, 15); await p.waitForTimeout(250)
      await p.mouse.click(cx + dx, cy + dy)
      if (await p.getByRole('dialog').count()) break
    }
    await p.waitForTimeout(3500); await p.keyboard.press('Escape'); await p.waitForTimeout(1200)
    const strands = p.getByRole('button', { name: /decorative strands/ }); const sb = await strands.boundingBox()
    await glide(p, sb.x + 16, sb.y + 16); await strands.click(); await p.waitForTimeout(2500); await strands.click(); await p.waitForTimeout(2500)
  })

  await clip('06-portfolio-and-risk', async (p) => {
    await p.goto(URL + '#portfolio', { waitUntil: 'networkidle' }); await p.waitForTimeout(2500)
    await scrollMain(p, 700, 2400); await p.waitForTimeout(1500); await scrollMain(p, 0, 1200)
    const nav = p.getByRole('button', { name: 'Risk', exact: true }); const b = await nav.boundingBox()
    await glide(p, b.x + 60, b.y + b.height / 2); await nav.click(); await p.waitForTimeout(2500)
    await scrollMain(p, 900, 2600); await p.waitForTimeout(800)
    const chk = p.getByRole('button', { name: 'All checks' }).first()
    if (await chk.count()) { const kb = await chk.boundingBox(); if (kb) { await glide(p, kb.x + 60, kb.y + kb.height / 2); await chk.click(); await p.waitForTimeout(2500) } }
  })
}
await browser.close()
