// Functional verification of primary flows against the live backend.
import { chromium } from 'playwright'
const OUT = process.argv[2]
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
p.on('pageerror', (e) => errors.push('pageerror ' + e.message))
p.on('console', (m) => { if (m.type() === 'error') errors.push('console ' + m.text().slice(0, 160)) })
const results = []
const step = async (name, fn) => {
  const t0 = Date.now()
  try { await fn(); results.push(['PASS', name, Date.now() - t0]) } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); await p.screenshot({ path: `${OUT}/fail-${name.replace(/\W+/g, '_')}.png` }) }
}
await p.goto('http://127.0.0.1:5173/#overview', { waitUntil: 'networkidle' })

await step('Alias route #overview shows Overview', async () => { await p.getByRole('heading', { name: 'Overview', exact: true }).waitFor({ timeout: 8000 }) })
await step('Global search → instrument deep link', async () => {
  await p.keyboard.press('Control+k')
  await p.getByPlaceholder(/Search workspaces/).fill('BTC')
  await p.keyboard.press('Enter')
  await p.waitForFunction(() => location.hash.startsWith('#markets?sym=BTC-USD'), null, { timeout: 5000 })
  await p.getByRole('heading', { name: 'BTC/USD' }).waitFor({ timeout: 8000 })
})
await step('Keyboard Alt+4 → Strategies', async () => {
  await p.locator('body').click({ position: { x: 5, y: 500 } })
  await p.keyboard.press('Alt+4')
  await p.getByText('Test a trading idea').waitFor({ timeout: 5000 })
})
await step('Strategies: run backtest', async () => {
  await p.getByRole('button', { name: /Channel breakout/ }).first().click()
  await p.getByRole('button', { name: 'BTC/USD', exact: true }).click()
  await p.getByRole('button', { name: 'Run backtest' }).first().click()
  await p.getByText(/Starting with/).waitFor({ timeout: 30000 })
})
await step('Strategies: validate on unseen data', async () => {
  await p.getByRole('button', { name: 'Validate on unseen data' }).click()
  await p.getByText('Evidence checks').waitFor({ timeout: 60000 })
})
await step('Overview: sphere node inspector', async () => {
  await p.evaluate(() => { location.hash = 'overview' })
  await p.waitForTimeout(2500)
  const c = p.locator('canvas[role=img]')
  const box = await c.boundingBox()
  // click near the centre where core/agent nodes live; try a few points
  let opened = false
  for (const [dx, dy] of [[0, 0], [0, -22], [0, 22], [-40, 0], [40, 0], [60, -60], [-60, 60]]) {
    await c.click({ position: { x: box.width / 2 + dx, y: box.height / 2 + dy } })
    if (await p.getByRole('dialog').count()) { opened = true; break }
  }
  if (!opened) throw new Error('no node drawer opened')
  await p.keyboard.press('Escape')
})
await step('Discoveries: open detail and reproduce', async () => {
  await p.evaluate(() => { location.hash = 'discoveries' })
  await p.getByText('Research evidence library').waitFor()
  await p.getByRole('button', { name: 'Reproduce' }).first().click()
  await p.getByText('Reproduced exactly').waitFor({ timeout: 30000 })
})
await step('Discoveries: compare two', async () => {
  const boxes = p.getByLabel('Compare')
  await boxes.nth(0).check(); await boxes.nth(1).check()
  await p.getByRole('button', { name: /Compare 2/ }).click()
  await p.getByText('Compare discoveries').waitFor()
  await p.getByText('Return, unseen data').waitFor()
  await p.keyboard.press('Escape')
})
await step('Research: agent history drawer', async () => {
  await p.evaluate(() => { location.hash = 'research' })
  await p.getByRole('heading', { name: 'Your research team' }).waitFor()
  await p.getByRole('button', { name: /Research Critic/ }).first().click()
  await p.getByText('Execution history').waitFor()
  await p.keyboard.press('Escape')
})
await step('Portfolio: place small paper order (risk-checked, filled)', async () => {
  await p.evaluate(() => { location.hash = 'portfolio' })
  await p.getByRole('button', { name: 'New paper order' }).click()
  await p.getByLabel(/Quantity/).fill('1000')
  await p.getByRole('button', { name: 'Place paper order' }).click()
  await p.getByText(/Filled \(simulated\)/).waitFor({ timeout: 10000 })
  await p.keyboard.press('Escape')
})
await step('Portfolio: emergency stop dialog opens and cancels', async () => {
  await p.getByRole('button', { name: 'Emergency stop' }).click()
  await p.getByText('Emergency stop?').waitFor()
  await p.getByRole('button', { name: 'Cancel' }).click()
})
await step('Risk: blocked filter + checks disclosure', async () => {
  await p.evaluate(() => { location.hash = 'risk' })
  await p.getByText('Risk controls').waitFor()
  await p.getByRole('button', { name: 'All checks' }).first().click()
  await p.getByText(/Order too large|Position too large/).first().waitFor()
})
await step('Activity: humanized timeline + technical toggle', async () => {
  await p.evaluate(() => { location.hash = 'activity' })
  await p.getByText('System activity').waitFor()
  await p.getByText(/updated with|already up to date|Market data refresh finished|Forecast generated/).first().waitFor({ timeout: 5000 })
})
await step('Forecasts: change horizon re-runs model', async () => {
  await p.evaluate(() => { location.hash = 'forecasts?sym=GBP-USD' })
  await p.getByRole('tab', { name: '1 week' }).click()
  await p.getByText(/GBP\/USD · /).waitFor({ timeout: 20000 })
  await p.getByText('What this says').waitFor()
})
for (const r of results) console.log(r.join('  '))
console.log('errors:', errors.length); errors.slice(0, 10).forEach((e) => console.log('  ' + e))
await b.close()
