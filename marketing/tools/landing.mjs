import { chromium } from 'playwright'
const OUT = process.argv[2]
const b = await chromium.launch()
const errs = []
for (const [w, h, dpr] of [[1440, 900, 1], [390, 844, 2]]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr })
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  await p.goto('http://127.0.0.1:5173/landing.html', { waitUntil: 'networkidle' })
  for (let y = 0; y < 12000; y += 700) { await p.evaluate((y) => window.scrollTo(0, y), y); await p.waitForTimeout(80) } // trigger lazy images
  await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(600)
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
  await p.screenshot({ path: `${OUT}/landing-${w}.png`, fullPage: true })
  console.log('landing', w, 'overflowX', overflow)
  if (w === 1440) {
    await p.locator('#beta').scrollIntoViewIfNeeded()
    await p.getByLabel('Email address').fill('not-an-email'); await p.getByRole('button', { name: 'Join the beta' }).last().click()
    await p.getByText('Please enter a valid email address.').waitFor(); console.log('invalid email: inline error shown')
    await p.getByLabel('Email address').fill('qa+landing-test@example.com')
    await p.getByRole('button', { name: 'Crypto' }).click(); await p.getByRole('button', { name: 'Forex' }).click()
    await p.getByRole('button', { name: 'Join the beta' }).last().click()
    await p.getByText('You’re on the list.').waitFor({ timeout: 5000 }); console.log('valid email: success state shown')
    await p.locator('#beta').screenshot({ path: `${OUT}/landing-beta-success.png` })
  }
  await p.close()
}
console.log('errors', errs.length, errs.slice(0, 5))
await b.close()
