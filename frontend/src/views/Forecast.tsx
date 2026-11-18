import { useEffect, useState } from 'react'
import type { ViewProps } from '../App'
import { Calibration, FanChart } from '../components/charts/Svg'
import { Badge, Disclosure, ErrorBox, InfoTip, Legend, Loading, Notice, Panel, PageHeader, SERIES, Segmented, Spinner } from '../components/ui'
import { api, useApi } from '../lib/api'
import { shortDate } from '../lib/explain'
import { num, pct, price } from '../lib/format'
import { paramToSym, symToParam, useParam } from '../lib/route'
import type { Market } from '../lib/types'

const HORIZONS = [{ value: '5', label: '1 week' }, { value: '20', label: '1 month' }, { value: '60', label: '3 months' }]

export function ForecastView({ go }: ViewProps) {
  const markets = useApi<Market[]>('/markets')
  const models = useApi<{ key: string; name: string; description: string }[]>('/forecast/models')
  const [symP, setSymP] = useParam('sym', 'BTC-USD')
  const sym = paramToSym(symP)
  const [model, setModel] = useState('drift')
  const [h, setH] = useState('20')
  const [out, setOut] = useState<any>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setPending(true); setError(null)
    const t = setTimeout(() => {
      api.post('/forecast', { symbol: sym, model, horizon: +h, evaluate: true, eval_origins: 120 })
        .then((r) => { if (live) setOut(r) })
        .catch((e) => { if (live) setError((e as Error).message) })
        .finally(() => { if (live) setPending(false) })
    }, 150)
    return () => { live = false; clearTimeout(t) }
  }, [sym, model, h])

  const mk = markets.data?.find((m) => m.symbol === sym)
  const dec = mk?.price_decimals ?? 4
  const ev = out?.evaluation
  const f = out?.forecast
  const last = f?.path?.at(-1)
  const me = ev?.models.find((x: any) => x.model === model)
  const naive = ev?.models.find((x: any) => x.model === 'naive')
  const best = ev?.models[0]

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Forecasts" title="Where could prices go?"
        subtitle="Transparent statistical models that give a range of plausible outcomes, and a record of how well each has done. They are baselines, not AI predictions or price targets." />

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-2">
          {markets.data?.map((m) => (
            <button key={m.symbol} onClick={() => setSymP(symToParam(m.symbol))} aria-pressed={sym === m.symbol}
              className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${sym === m.symbol ? 'bg-white text-ink-950' : 'bg-white/[0.06] text-ink-100 hover:bg-white/[0.1]'}`}>{m.symbol}</button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">{models.data?.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select>
          <Segmented value={h} onChange={setH} options={HORIZONS} />
          {pending && <Spinner />}
        </div>
      </div>
      <ErrorBox error={error} />

      {!out ? <Panel><Loading rows={6} /></Panel> : (
        <>
          <div className="grid grid-cols-12 gap-5">
            <Panel className="col-span-12 xl:col-span-8" title={`${sym} · ${f.name}`} tag={<Badge tone="vi">Forecast, not observed</Badge>}
              right={<Legend items={[{ label: 'Observed', color: '#eef2f6' }, { label: 'Central estimate', color: SERIES[2], dashed: true }, { label: '50 / 80 / 95% ranges', color: `${SERIES[2]}77` }]} />}>
              <div className={pending ? 'opacity-60 transition-opacity' : 'transition-opacity'}><FanChart history={out.history} path={f.path} color={SERIES[2]} height={380} decimals={dec} /></div>
            </Panel>
            <Panel className="col-span-12 xl:col-span-4" title="What this says">
              <div className="space-y-4 text-[14.5px] leading-relaxed text-ink-100">
                <p>By <b className="text-white">{shortDate(last.t)}</b>, the model's central estimate for {sym} is <b className="text-white">{price(last.mean, dec)}</b> ({pct(last.mean / f.origin_price - 1, 1)} from {price(f.origin_price, dec)}).</p>
                <p>If its view of uncertainty is right, there is a <b className="text-white">50%</b> chance the price is between {price(last.lo50, dec)} and {price(last.hi50, dec)}, and a <b className="text-white">95%</b> chance it is between {price(last.lo95, dec)} and {price(last.hi95, dec)}.</p>
                {me && naive && (
                  <p className="text-ink-200">
                    <span className="font-medium text-white">Track record:</span> over the last {ev.origins} forecasts, this model was{' '}
                    {me.model === 'naive' ? 'the baseline everything is compared with' : me.mase < 1 ? <b className="text-up">{pct(1 - me.mase, 0, false)} more accurate</b> : <b className="text-am">{pct(me.mase - 1, 0, false)} less accurate</b>}
                    {me.model !== 'naive' && ' than simply assuming no change'}. Its 95% ranges contained the real outcome <b className="text-white">{pct(me.coverage['95'], 0, false)}</b> of the time.
                  </p>
                )}
              </div>
              <div className="mt-5"><Notice tone="am" title="Read with care">Ranges assume price moves follow a normal pattern with recent volatility. Real markets have sudden jumps these models cannot anticipate.</Notice></div>
            </Panel>
          </div>

          <div className="grid grid-cols-12 gap-5">
            <Panel className="col-span-12 xl:col-span-7" title="How the models compare" subtitle={`Tested on ${ev.origins} past forecasts from ${shortDate(ev.first_origin)} ${ev.first_origin.slice(0, 4)} to ${shortDate(ev.last_origin)} ${ev.last_origin.slice(0, 4)}, ${HORIZONS.find((x) => x.value === h)?.label} ahead.`} bodyClass="!px-0">
              <div className="overflow-x-auto">
                <table className="data">
                  <thead><tr><th>Model</th><th className="!text-right">Typical error <InfoTip text="Mean absolute error in percent at the forecast horizon." /></th><th className="!text-right">vs. no-change <InfoTip text="Below 1.00 means more accurate than assuming tomorrow equals today." /></th><th className="!text-right">Direction right</th><th className="!text-right">95% range held</th></tr></thead>
                  <tbody>{ev.models.map((m: any) => (
                    <tr key={m.model} onClick={() => setModel(m.model)} className={`cursor-pointer ${m.model === model ? 'bg-vi/[0.07]' : ''}`}>
                      <td className="!pl-5"><span className="text-white">{m.name}</span>{m.model === best?.model && <span className="ml-2"><Badge tone="up">Most accurate</Badge></span>}</td>
                      <td className="text-right">{num(m.mae_pct, 2)}%</td>
                      <td className={`text-right ${m.mase < 1 ? 'text-up' : m.mase > 1.02 ? 'text-am' : ''}`}>{num(m.mase, 2)}</td>
                      <td className="text-right">{m.directional_accuracy === null ? '—' : pct(m.directional_accuracy, 0, false)}</td>
                      <td className={`!pr-5 text-right ${Math.abs(m.coverage['95'] - 0.95) > 0.06 ? 'text-am' : ''}`}>{pct(m.coverage['95'], 0, false)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <p className="px-5 pt-3 text-[12.5px] leading-relaxed text-ink-300">For most liquid markets, beating “no change” consistently is genuinely hard — a model that matches it is doing its job honestly.</p>
            </Panel>
            <Panel className="col-span-12 xl:col-span-5" title="Are the ranges honest?" subtitle="How often each stated range actually contained the outcome. On the diagonal = well calibrated; below = overconfident.">
              <Calibration rows={ev.models.map((m: any, i: number) => ({ label: m.name, color: m.model === model ? SERIES[2] : ['#4a5562', '#5b6673', '#6c7784', '#7f8a97'][i % 4], coverage: m.coverage }))} />
            </Panel>
          </div>

          <Disclosure title="Accuracy by market conditions" meta="Regime-specific error">
            <div className="overflow-x-auto rounded-[12px] ring-1 ring-white/[0.05]">
              <table className="data">
                <thead><tr><th>Model</th><th className="!text-right">Calm markets</th><th className="!text-right">Normal</th><th className="!text-right">Volatile</th></tr></thead>
                <tbody>{ev.models.map((m: any) => (
                  <tr key={m.model}><td className="text-white">{m.name}</td>
                    {['low_vol', 'normal_vol', 'high_vol'].map((g) => <td key={g} className="text-right">{m.by_regime[g] ? <>{num(m.by_regime[g].mae_pct, 2)}% <span className="text-ink-400">({m.by_regime[g].n})</span></> : '—'}</td>)}
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <p className="mt-3 text-[12.5px] text-ink-300">Typical error at the horizon, split by the volatility regime when each forecast was made. Errors are larger in volatile markets for every model.</p>
          </Disclosure>
          <p className="text-[12.5px] text-ink-400">{out.disclaimer} Want to act on a view? <button onClick={() => go('strategy', { sym: symToParam(sym) })} className="text-cy hover:underline">Test a strategy on {sym}</button> — every idea is validated before it can paper-trade.</p>
        </>
      )}
    </div>
  )
}
