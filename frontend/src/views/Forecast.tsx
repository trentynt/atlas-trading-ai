import { useState } from 'react'
import type { ViewProps } from '../App'
import { Calibration, FanChart } from '../components/charts/Svg'
import { Badge, Button, Empty, ErrorBox, Field, Legend, Panel, SERIES, Stat } from '../components/ui'
import { api, useAction, useApi } from '../lib/api'
import { num, pct } from '../lib/format'
import type { Market } from '../lib/types'

export function ForecastView(_: ViewProps) {
  const markets = useApi<Market[]>('/markets')
  const models = useApi<{ key: string; name: string; description: string }[]>('/forecast/models')
  const [sym, setSym] = useState('EUR/USD')
  const [model, setModel] = useState('drift')
  const [h, setH] = useState(20)
  const [out, setOut] = useState<any>(null)
  const run = useAction(async () => setOut(await api.post('/forecast', { symbol: sym, model, horizon: h, evaluate: true, eval_origins: 120 })))
  const dec = markets.data?.find((m) => m.symbol === sym)?.price_decimals ?? 4
  const ev = out?.evaluation
  const f = out?.forecast
  const last = f?.path?.at(-1)

  return (
    <div className="grid grid-cols-12 gap-3">
      <Panel className="col-span-12" kicker="CONFIGURE" title="Forecasting laboratory"
        tag={<Badge tone="vi">statistical baselines · not price targets</Badge>}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Instrument"><select value={sym} onChange={(e) => setSym(e.target.value)}>{markets.data?.map((m) => <option key={m.symbol}>{m.symbol}</option>)}</select></Field>
          <Field label="Model"><select value={model} onChange={(e) => setModel(e.target.value)}>{models.data?.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
          <Field label="Horizon (bars)"><input type="number" min={1} max={120} value={h} onChange={(e) => setH(Number(e.target.value))} className="w-24" /></Field>
          <Button tone="primary" onClick={() => run.run()} disabled={run.pending}>{run.pending ? 'fitting & evaluating…' : '▶ Forecast + rolling evaluation'}</Button>
          <span className="text-[11px] text-ink-300">{models.data?.find((m) => m.key === model)?.description}</span>
        </div>
        <ErrorBox error={run.error} />
      </Panel>

      {!out ? <div className="col-span-12"><Panel><Empty>Choose an instrument, model and horizon. Each run fits on past data only and scores {`~120`} rolling forecast origins.</Empty></Panel></div> : (
        <>
          <Panel className="col-span-12 xl:col-span-8" title={`${sym} · ${f.name}`} tag={<Badge tone="vi">FORECAST ≠ OBSERVED</Badge>}
            right={<Legend items={[{ label: 'Observed', color: '#e6edf7' }, { label: 'Forecast mean', color: SERIES[2], dashed: true }, { label: '50 / 80 / 95% intervals', color: `${SERIES[2]}66` }]} />}>
            <FanChart history={out.history} path={f.path} color={SERIES[2]} height={360} decimals={dec} />
            <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="origin" value={f.origin} valueClass="text-[13px]" sub={`last ${f.origin_price.toFixed(dec)}`} />
              <Stat label={`mean @ h=${h}`} value={last.mean.toFixed(dec)} sub={pct(last.mean / f.origin_price - 1)} />
              <Stat label="95% interval" value={`${last.lo95.toFixed(dec)} – ${last.hi95.toFixed(dec)}`} valueClass="text-[13px]" />
              <Stat label="daily σ (log)" value={pct(f.sigma_daily, 3, false)} sub="trailing 60 bars" />
            </div>
            <p className="mt-2 text-[10.5px] text-ink-300">{out.disclaimer} Intervals assume Gaussian log-returns with trailing volatility × √h; their empirical calibration is measured on the right.</p>
          </Panel>
          <Panel className="col-span-12 xl:col-span-4" title="Interval calibration" tag={<Badge>{ev.origins} origins</Badge>}>
            <Calibration rows={ev.models.map((m: any, i: number) => ({ label: m.name, color: m.model === model ? SERIES[2] : ['#5f7491', '#3a4d68', '#8ea2bd', '#26354b'][i % 4], coverage: m.coverage }))} />
            <p className="mt-1 text-[10.5px] text-ink-300">Dashed diagonal = perfect calibration. Points below it mean intervals are too narrow (overconfident). Selected model highlighted; others in neutral.</p>
          </Panel>
          <Panel className="col-span-12 lg:col-span-7" title="Model comparison (rolling-origin, final horizon)" tag={<Badge>{ev.first_origin} → {ev.last_origin}</Badge>} bodyClass="p-0">
            <table className="data">
              <thead><tr><th>model</th><th>MAE %</th><th>RMSE %</th><th>MASE</th><th>direction hit</th><th>bias %</th><th>cov 50</th><th>cov 80</th><th>cov 95</th></tr></thead>
              <tbody>{ev.models.map((m: any) => (
                <tr key={m.model} className={m.model === model ? 'bg-vi/5' : ''}>
                  <td className="text-white">{m.name}</td><td>{num(m.mae_pct, 3)}</td><td>{num(m.rmse_pct, 3)}</td>
                  <td className={m.mase < 1 ? 'text-up' : m.mase > 1.02 ? 'text-dn' : ''}>{num(m.mase, 3)}</td>
                  <td>{m.directional_accuracy === null ? '—' : pct(m.directional_accuracy, 1, false)}</td><td>{num(m.bias_pct, 3)}</td>
                  {(['50', '80', '95'] as const).map((l) => <td key={l} className={Math.abs(m.coverage[l] - +l / 100) > 0.08 ? 'text-am' : ''}>{pct(m.coverage[l], 0, false)}</td>)}
                </tr>
              ))}</tbody>
            </table>
            <p className="px-3 py-2 text-[10.5px] text-ink-300">{ev.note} Directional accuracy is undefined for the naive model (it predicts no change).</p>
          </Panel>
          <Panel className="col-span-12 lg:col-span-5" title="Regime-specific error (MAE % at final horizon)" bodyClass="p-0">
            <table className="data">
              <thead><tr><th>model</th><th>low vol</th><th>normal vol</th><th>high vol</th></tr></thead>
              <tbody>{ev.models.map((m: any) => (
                <tr key={m.model}><td className="text-white">{m.name}</td>
                  {['low_vol', 'normal_vol', 'high_vol'].map((g) => <td key={g}>{m.by_regime[g] ? `${num(m.by_regime[g].mae_pct, 3)} (n=${m.by_regime[g].n})` : '—'}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </Panel>
        </>
      )}
    </div>
  )
}
