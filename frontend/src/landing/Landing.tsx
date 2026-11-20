import { useEffect, useState, type FormEvent, type ReactNode } from 'react'

/* SIGNAL landing page. Every claim here maps to a capability that exists in the product today;
   roadmap items are labelled as such. Live numbers come from the running SIGNAL instance when available. */

const IMG = (n: string) => `/landing/${n}.webp`

function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-[linear-gradient(145deg,#1d2a2d,#0f1517)] ring-1 ring-white/[0.08]">
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" strokeLinecap="round"><path d="M3 13.5h3.2l2.3-6 3.2 11 2.6-8.2 1.6 3.2H21" stroke="#5eead4" strokeWidth="1.9" strokeLinejoin="round" /></svg>
      </span>
      <span className="text-[15px] font-semibold tracking-[0.14em] text-white">SIGNAL</span>
    </span>
  )
}

function Shot({ src, alt, className = '' }: { src: string; alt: string; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-[18px] bg-[#0b0e12] ring-1 ring-white/[0.09] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.02)] ${className}`}>
      <img src={src} alt={alt} loading="lazy" className="block h-auto w-full" />
    </div>
  )
}

function Section({ id, eyebrow, title, intro, children }: { id?: string; eyebrow: string; title: ReactNode; intro?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="mx-auto max-w-[1180px] scroll-mt-20 px-5 py-20 md:py-28">
      <div className="max-w-[760px]">
        <div className="text-[14px] font-medium text-cy">{eyebrow}</div>
        <h2 className="mt-2 text-[32px] leading-[1.12] font-semibold tracking-[-0.03em] text-white md:text-[44px]">{title}</h2>
        {intro && <p className="mt-4 text-[17px] leading-relaxed text-ink-200">{intro}</p>}
      </div>
      <div className="mt-12">{children}</div>
    </section>
  )
}

const STEPS: [string, string, string][] = [
  ['Read the markets', 'Fresh daily data is downloaded, validated and versioned. Gaps, duplicates and stale prices are caught before research starts.', 'Market Intelligence'],
  ['Propose ideas', 'Strategy ideas suited to current conditions are generated within a fixed search budget, with every parameter logged.', 'Strategy Discovery'],
  ['Test on later data', 'Each idea is designed on older data, judged on later data with realistic trading costs, and must pass one look at sealed data before it counts.', 'Backtesting'],
  ['Stress-test', 'Drawdowns, tail losses, doubled costs and nearby settings show how the idea could fail.', 'Risk Analysis'],
  ['Reject what could be luck', 'A critic rejects by default. The bar rises with every idea tried, so a lucky result can’t slip through.', 'Research Critic'],
  ['Paper-trade the survivors', 'Ideas that pass every check can trade with simulated money, behind risk limits the agents can’t override.', 'Portfolio Research'],
]

const LIMITS: [string, string][] = [
  ['Paper trading only', 'SIGNAL has no broker connection and cannot place real trades, take deposits or move money.'],
  ['Daily data', 'Research runs on daily bars. There is no intraday or tick data, no order book, and no live streaming quotes.'],
  ['Forex uses reference rates', 'EUR/USD, GBP/USD and USD/JPY use the European Central Bank’s daily reference rate — not an executable price.'],
  ['Backtests are history', 'Passing every check is evidence, not a promise. Past performance does not predict future results.'],
  ['Forecasts are baselines', 'Forecasts come from transparent statistical models with stated uncertainty. They are not AI price predictions.'],
  ['Research runs while SIGNAL runs', 'Autonomous research pauses whenever the machine hosting SIGNAL is asleep or stopped.'],
]

export function Landing() {
  const [stats, setStats] = useState<{ tested: number; accepted: number; agentRuns: number; bars: number } | null>(null)
  useEffect(() => {
    fetch('/api/system/overview').then((r) => (r.ok ? r.json() : null)).then((o) => {
      if (o?.counts) setStats({ tested: o.counts.experiments, accepted: o.counts.accepted, agentRuns: o.counts.agent_runs, bars: o.counts.bars })
    }).catch(() => {})
  }, [])

  return (
    <div className="min-h-full overflow-x-hidden">
      {/* nav */}
      <header className="material fixed inset-x-0 top-0 z-30 border-b border-white/[0.06]">
        <div className="mx-auto flex h-[60px] max-w-[1180px] items-center gap-6 px-5">
          <a href="#top" aria-label="SIGNAL home"><Logo /></a>
          <nav className="ml-4 hidden gap-6 text-[14px] text-ink-200 md:flex">
            <a href="#how" className="hover:text-white">How it works</a>
            <a href="#product" className="hover:text-white">Product</a>
            <a href="#markets" className="hover:text-white">Markets</a>
            <a href="#honesty" className="hover:text-white">Limitations</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <a href="/#overview" className="hidden rounded-[10px] px-3.5 py-2 text-[14px] font-medium text-ink-100 hover:bg-white/[0.06] sm:inline-block">Open the app</a>
            <a href="#beta" className="rounded-[10px] bg-cy px-4 py-2 text-[14px] font-semibold text-[#06231e] hover:bg-[#7ff0de]">Join the beta</a>
          </div>
        </div>
      </header>

      {/* hero */}
      <section id="top" className="relative px-5 pt-[132px] pb-12 md:pt-[168px]">
        <div className="relative mx-auto max-w-[920px] text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/[0.05] px-3.5 py-1.5 text-[13px] text-ink-200 ring-1 ring-inset ring-white/[0.08]">
            <span className="h-1.5 w-1.5 rounded-full bg-cy" />Private beta · paper trading only
          </div>
          <h1 className="mt-6 text-[44px] leading-[1.04] font-semibold tracking-[-0.04em] text-white md:text-[72px]">
            Your personal AI trading<br className="hidden md:block" /> research company.
          </h1>
          <p className="mx-auto mt-6 max-w-[680px] text-[18px] leading-relaxed text-ink-200 md:text-[20px]">
            A research team that proposes trading ideas, tests them on data they’ve never seen, and rejects anything that could be luck. Then paper-trade what survives — behind risk limits you control.
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <a href="#beta" className="rounded-[12px] bg-cy px-6 py-3 text-[15px] font-semibold text-[#06231e] hover:bg-[#7ff0de]">Join the private beta</a>
            <a href="#how" className="rounded-[12px] bg-white/[0.07] px-6 py-3 text-[15px] font-medium text-white ring-1 ring-inset ring-white/[0.1] hover:bg-white/[0.11]">See how it works</a>
          </div>
        </div>
        <div className="relative mx-auto mt-16 max-w-[1180px]">
          <Shot src={IMG('01-overview')} alt="The SIGNAL Overview: a plain-language research summary, the research network, attention items and market cards" className="relative" />
          <p className="mt-4 text-center text-[13.5px] text-ink-300">The real interface, showing real data.{stats ? ` In this preview, ${stats.tested} ideas have been tested and ${stats.accepted} survived current validation.` : ''}</p>
        </div>
      </section>

      {/* benefits */}
      <Section id="product" eyebrow="Why SIGNAL" title="The discipline of a quant desk, without the desk." intro="Most trading tools help you find patterns. SIGNAL is built to tell you which patterns are probably not real.">
        <div className="grid gap-x-14 gap-y-10 md:grid-cols-2">
          {[
            ['A research team that works while you don’t', 'Seven specialised agents read markets, propose ideas, test them, stress them and review the evidence — on a schedule you set. Every step is recorded.'],
            ['Evidence, not hype', 'Ideas are judged on data they never saw. Doubled trading costs, nearby settings and a correction for how many ideas have been tried must all hold up.'],
            ['Risk limits nothing can override', 'Drawdown, daily loss, position size, exposure, correlation, volatility and a kill switch are enforced by the engine on every simulated order.'],
            ['Every result is reproducible', 'Each experiment stores its exact dataset version and code version. Reproduce it with one click and get the same numbers.'],
          ].map(([t, b]) => (
            <div key={t} className="border-t border-white/[0.08] pt-6">
              <h3 className="text-[19px] font-semibold tracking-[-0.015em] text-white">{t}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-200">{b}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* workflow */}
      <Section id="how" eyebrow="How it works" title="From idea to evidence in six steps." intro="Every research cycle follows the same process. The agents are deterministic programs, so the same data always produces the same decisions. Most ideas are rejected — that is the point.">
        <ol className="grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map(([t, b, who], i) => (
            <li key={t} className="border-t border-white/[0.08] pt-5">
              <div className="flex items-center justify-between"><span className="num text-[13px] text-cy">0{i + 1}</span><span className="text-[12.5px] text-ink-300">{who}</span></div>
              <h3 className="mt-3 text-[17px] font-semibold text-white">{t}</h3>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-ink-300">{b}</p>
            </li>
          ))}
        </ol>
        <div className="mt-16 grid items-center gap-10 lg:grid-cols-[1fr_1.35fr]">
          <div>
            <h3 className="text-[26px] leading-tight font-semibold tracking-[-0.025em] text-white">See every decision your research team makes.</h3>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-200">See which agent is working, what each cycle found, and why every rejected idea was rejected — in plain language, with the technical detail one click away.</p>
          </div>
          <Shot src={IMG('03-research')} alt="The Research workspace showing the six-step cycle, seven agents and the latest findings" />
        </div>
        <div className="mt-16 grid items-center gap-10 lg:grid-cols-[1.35fr_1fr]">
          <Shot src={IMG('04b-strategy-validation')} alt="Strategy validation: design, validation and final-test periods with eight evidence checks" className="order-2 lg:order-1" />
          <div className="order-1 lg:order-2">
            <h3 className="text-[26px] leading-tight font-semibold tracking-[-0.025em] text-white">Test any idea against data it has never seen.</h3>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-200">History is split in time order. Settings are fitted on the past, checked on the middle, and judged once on a final period kept untouched — then re-tested period by period.</p>
          </div>
        </div>
        <div className="mt-16 grid items-center gap-10 lg:grid-cols-[1fr_1.35fr]">
          <div>
            <h3 className="text-[26px] leading-tight font-semibold tracking-[-0.025em] text-white">Your research, mapped.</h3>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-200">Every dataset, agent, strategy family and experiment — connected by the relationships actually recorded in your research database. Light moves only when something really happens.</p>
          </div>
          <Shot src={IMG('07-computation-sphere')} alt="The research network sphere showing agents, markets, strategy families and experiments" />
        </div>
        <div className="mt-16 grid gap-6 md:grid-cols-2">
          <Shot src={IMG('05-portfolio')} alt="Paper portfolio with simulated equity, strategy allocations and order history" />
          <Shot src={IMG('06-risk')} alt="Risk controls with limit gauges, market conditions and the risk event log" />
        </div>
        <p className="mt-4 text-center text-[13px] text-ink-300">Paper portfolio and risk controls. All execution is simulated.</p>
      </Section>

      {/* markets */}
      <Section id="markets" eyebrow="Market coverage" title="Honest about what’s supported." intro="SIGNAL only shows markets with verified data sources. More asset classes are planned, and will arrive only when the data is good enough.">
        <div className="grid gap-5 md:grid-cols-2">
          <div className="panel px-7 py-7">
            <div className="flex items-center gap-2 text-[14px] font-medium text-up"><span className="h-2 w-2 rounded-full bg-up" />Available now</div>
            <ul className="mt-4 space-y-4">
              <li><div className="text-[17px] font-semibold text-white">Crypto · BTC/USD, ETH/USD</div><div className="text-[14.5px] text-ink-300">Historical daily candles (open, high, low, close, volume), cross-checked against a second exchange. Not live prices. Beta access depends on exchange data licensing, which is still being confirmed.</div></li>
              <li><div className="text-[17px] font-semibold text-white">Forex · EUR/USD, GBP/USD, USD/JPY</div><div className="text-[14.5px] text-ink-300">European Central Bank daily reference rates — one official close per business day, not an executable quote.</div></li>
            </ul>
          </div>
          <div className="panel px-7 py-7">
            <div className="flex items-center gap-2 text-[14px] font-medium text-ink-300"><span className="h-2 w-2 rounded-full bg-ink-400" />On the roadmap — not available</div>
            <div className="mt-4 flex flex-wrap gap-2">{['Stocks', 'ETFs', 'Options', 'Futures', 'Live prices', 'Intraday research'].map((x) => <span key={x} className="rounded-full bg-white/[0.05] px-3.5 py-1.5 text-[14px] text-ink-300 ring-1 ring-inset ring-white/[0.06]">{x}</span>)}</div>
            <p className="mt-4 text-[14.5px] leading-relaxed text-ink-300">We won’t list a market until its data can be validated, versioned and reproduced to the same standard.</p>
          </div>
        </div>
      </Section>

      {/* honesty */}
      <Section id="honesty" eyebrow="Transparent limitations" title="What SIGNAL is not.">
        <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {LIMITS.map(([t, b]) => (
            <div key={t} className="border-t border-am/30 pt-5">
              <h3 className="text-[16px] font-semibold text-white">{t}</h3>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-ink-300">{b}</p>
            </div>
          ))}
        </div>
      </Section>

      <Waitlist />

      <footer className="border-t border-white/[0.06]">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-start justify-between gap-6 px-5 py-10 text-[13px] text-ink-300">
          <div className="max-w-[560px] space-y-2">
            <Logo />
            <p>SIGNAL is a provisional name pending trademark clearance. Research and paper-trading software only — not investment advice, not a broker, and not an offer to buy or sell any financial instrument.</p>
          </div>
          <div className="flex gap-6"><a href="/#overview" className="hover:text-white">Open the app</a><a href="#honesty" className="hover:text-white">Limitations</a><a href="#beta" className="hover:text-white">Private beta</a></div>
        </div>
      </footer>
    </div>
  )
}

const MARKETS = [['crypto', 'Crypto'], ['forex', 'Forex'], ['stocks', 'Stocks'], ['etfs', 'ETFs'], ['options', 'Options'], ['futures', 'Futures']] as const

function Waitlist() {
  const [email, setEmail] = useState('')
  const [markets, setMarkets] = useState<string[]>([])
  const [experience, setExperience] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'already' | 'error'>('idle')
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email.trim())) { setState('error'); setError('Please enter a valid email address.'); return }
    setState('sending'); setError('')
    try {
      const r = await fetch('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.trim(), markets, experience: experience || null, source: 'landing' }) })
      if (!r.ok) throw new Error(r.status === 422 ? 'Please check your details and try again.' : `The server responded with ${r.status}.`)
      const j = await r.json()
      setState(j.status === 'already_registered' ? 'already' : 'done')
    } catch (err) {
      setState('error'); setError((err as Error).message === 'Failed to fetch' ? 'We couldn’t reach the sign-up service. Please try again in a moment.' : (err as Error).message)
    }
  }
  return (
    <section id="beta" className="scroll-mt-20 px-5 pb-24">
      <div className="panel relative mx-auto max-w-[880px] overflow-hidden px-6 py-12 text-center md:px-14">
        <div className="relative">
          <div className="text-[14px] font-medium text-cy">Private beta</div>
          <h2 className="mt-2 text-[32px] leading-[1.1] font-semibold tracking-[-0.03em] text-white md:text-[42px]">Get early access.</h2>
          <p className="mx-auto mt-3 max-w-[560px] text-[16px] leading-relaxed text-ink-200">We’re opening SIGNAL to a small group of traders first. There’s nothing to pay and no subscription during the beta.</p>
          {state === 'done' || state === 'already' ? (
            <div role="status" className="mx-auto mt-8 max-w-[480px] rounded-[16px] bg-up/[0.08] px-6 py-6 ring-1 ring-inset ring-up/25">
              <div className="text-[18px] font-semibold text-up">{state === 'done' ? 'You’re on the list.' : 'You’re already on the list.'}</div>
              <p className="mt-1 text-[14.5px] text-ink-200">We’ll email {email.trim()} when a beta place opens up.</p>
            </div>
          ) : (
            <form onSubmit={submit} noValidate className="mx-auto mt-8 max-w-[560px] space-y-5 text-left">
              <div className="flex flex-col gap-2 sm:flex-row">
                <label className="sr-only" htmlFor="email">Email address</label>
                <input id="email" type="email" autoComplete="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)}
                  className="h-12 flex-1 !rounded-[12px] !px-4 !text-[15px]" aria-invalid={state === 'error'} />
                <button type="submit" disabled={state === 'sending'} className="h-12 rounded-[12px] bg-cy px-6 text-[15px] font-semibold text-[#06231e] hover:bg-[#7ff0de] disabled:opacity-60">{state === 'sending' ? 'Joining…' : 'Join the beta'}</button>
              </div>
              <fieldset>
                <legend className="mb-2 text-[13.5px] text-ink-200">What do you trade? <span className="text-ink-300">(optional)</span></legend>
                <div className="flex flex-wrap gap-2">
                  {MARKETS.map(([v, l]) => {
                    const on = markets.includes(v)
                    return <button key={v} type="button" aria-pressed={on} onClick={() => setMarkets(on ? markets.filter((x) => x !== v) : [...markets, v])}
                      className={`rounded-full px-3.5 py-1.5 text-[13.5px] font-medium transition-colors ${on ? 'bg-white text-ink-950' : 'bg-white/[0.06] text-ink-100 hover:bg-white/[0.1]'}`}>{l}</button>
                  })}
                </div>
              </fieldset>
              <label className="block">
                <span className="mb-2 block text-[13.5px] text-ink-200">Trading experience <span className="text-ink-300">(optional)</span></span>
                <select value={experience} onChange={(e) => setExperience(e.target.value)} className="w-full !py-2.5">
                  <option value="">Prefer not to say</option><option value="new">New to trading</option><option value="intermediate">Some experience</option><option value="advanced">Advanced</option><option value="professional">Professional</option>
                </select>
              </label>
              {state === 'error' && <p role="alert" className="text-[14px] text-dn">{error}</p>}
              <p className="text-[12.5px] leading-relaxed text-ink-300">We use your email only to contact you about the beta. In this preview build, sign-ups are stored in the SIGNAL database on the server you’re visiting — nothing is sent to third parties.</p>
            </form>
          )}
        </div>
      </div>
    </section>
  )
}
