// TypeScript mirrors of the backend JSON contracts (backend/atlas/api).

export type Num = number | null

export interface Market {
  symbol: string
  asset_class: 'fx' | 'crypto'
  providers: string[]
  last_ts: string | null
  last_close: Num
  change_1d: Num
  rows: number
  version: string | null
  provider: string | null
  attribution: string | null
  has_ohlc: boolean | null
  has_volume: boolean | null
  provider_notes: string | null
  stale_days: Num
  is_stale: boolean
  missing_periods: Num
  price_decimals: number
  quality_status: 'ok' | 'warn' | 'fail' | null
  quality_issues: { level: 'info' | 'warn' | 'fail'; code: string; text: string }[]
  cross_source: CrossSource | null
  licensed: boolean
  deployment_mode: 'personal' | 'beta'
  intraday: string[]
  costs: { spread_bps: number; fee_bps: number; slippage_bps: number }
  kind: 'historical' | 'reference'
  label: string
}

export interface CrossSource {
  secondary: string
  status: 'ok' | 'mismatch' | 'possible_time_shift' | 'no_overlap' | 'unavailable'
  overlap?: number
  start?: string
  end?: string
  median_abs_bps?: number
  p95_abs_bps?: number
  max_abs_bps?: number
  days_over_tolerance?: number
  tolerance_bps?: number
  error?: string
}

export interface Bar { t: string; o: Num; h: Num; l: Num; c: number; v: Num }

export interface AtlasEvent {
  id?: number
  ts: string
  category: string
  level: 'info' | 'warn' | 'error'
  source: string | null
  message: string
  data: Record<string, unknown> & { node?: string }
}

export interface Metrics {
  bars?: number
  start?: string
  end?: string
  total_return?: Num
  annualized_return?: Num
  annualized_vol?: Num
  max_drawdown?: Num
  longest_drawdown_bars?: number
  sharpe?: Num
  sortino?: Num
  calmar?: Num
  num_trades: number
  win_rate?: Num
  profit_factor?: Num
  expectancy?: Num
  expectancy_pct?: Num
  avg_trade_bars?: Num
  exposure?: Num
  var_95?: Num
  cvar_95?: Num
  costs_paid?: Record<string, number>
  excess_return_vs_benchmark?: Num
}

export interface Point { t: string; v: Num }

export interface Trade {
  side: 'long' | 'short'
  entry_ts: string
  entry_price: number
  exit_ts: string
  exit_price: number
  exit_reason: string
  qty: number
  pnl: number
  return: number
  bars_held: number
  costs: number
  regime: string | null
}

export interface BacktestPayload {
  metrics: Metrics
  benchmark: Partial<Metrics>
  attribution: {
    by_side: Record<string, { pnl: number; trades: number; wins: number }>
    by_exit_reason: Record<string, { pnl: number; trades: number; wins: number }>
    by_regime: Record<string, { pnl: number; trades: number; wins: number }>
    total_costs: number
    gross_pnl_before_costs: number
  }
  config: Record<string, unknown>
  trades: Trade[]
  orders: Record<string, unknown>[]
  series: { equity: Point[]; benchmark: Point[]; drawdown: Point[]; position: Point[] }
  runtime_ms?: number
  dataset_version?: string
  data_note?: string
  experiment_id?: number
  holdout?: { start?: string; policy?: 'forward_only' | 'last_20pct'; included?: boolean; accesses?: number } | null
}

export interface ParamSpec {
  name: string
  kind: 'int' | 'float' | 'bool'
  default: number | boolean
  low: Num
  high: Num
  grid: (number | boolean)[]
  description: string
}

export interface StrategySpec {
  key: string
  name: string
  family: string
  description: string
  rules: string[]
  risk_assumptions: string[]
  params: ParamSpec[]
  preferred_regimes: string[]
}

export interface CriticCheck {
  name: string
  value: unknown
  passed: boolean
  threshold: string
  blocking: boolean
  explanation: string
}

export interface Experiment {
  id: number
  created_at: string
  kind: 'hypothesis_test' | 'manual_backtest' | 'research_report'
  status: string
  symbol: string | null
  strategy: string | null
  params: Record<string, unknown> | null
  config: Record<string, unknown> | null
  dataset_version: string | null
  code_version: string | null
  metrics: Record<string, any> | null
  verdict: 'accepted' | 'rejected' | null
  disposition?: string | null
  disposition_label?: string | null
  methodology?: string | null
  evidence?: any
  reasons: string[] | null
  job_id: number | null
  cycle_id: number | null
  hypothesis: { rationale: string; origin: string } | null
  artifacts?: Record<string, any>
}

export interface AgentInfo {
  name: string
  title: string
  role: string
  tools: string[]
  status: 'idle' | 'running'
  current: { run_id: number; since: string } | null
  last_run: {
    id: number
    status: string
    started_at: string
    finished_at: string | null
    duration_ms: Num
    error: string | null
    inputs: unknown
    outputs: unknown
  } | null
  runs: number
  errors: number
  avg_ms: Num
}

export interface Job {
  id: number
  type: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'limited' | 'skipped'
  user_id?: number
  trigger?: string
  attempts?: number
  max_attempts?: number
  next_run_at?: string | null
  estimate?: Record<string, any>
  usage?: Usage | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  progress: number
  message: string | null
  error: string | null
  params: Record<string, unknown>
  result: Record<string, any> | null
}

export interface Account {
  cash: number
  initial_cash: number
  state: 'running' | 'paused' | 'halted'
  equity: number
  market_value: number
  gross_exposure: number
  net_exposure: number
  unrealized_pnl: number
  realized_pnl: number
  fees_paid: number
  total_return: number
  drawdown: number
  daily_pnl_pct: number
  peak_equity: number
  mode: 'PAPER'
  pricing: string
  updated_at: string
}

export interface Position {
  symbol: string
  strategy_id: string
  qty: number
  avg_price: number
  mark: number
  market_value: number
  unrealized_pnl: number
  opened_at: string
}

export interface Order {
  id: number
  created_at: string
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  type: 'market' | 'limit'
  limit_price: Num
  status: 'new' | 'open' | 'filled' | 'cancelled' | 'rejected'
  filled_price: Num
  filled_at: string | null
  fee: number
  strategy_id: string
  reason: string | null
  reject_reason: string | null
}

export interface StrategyConfig {
  id: number
  created_at: string
  name: string
  strategy: string
  symbol: string
  params: Record<string, unknown>
  status: 'deployed' | 'paused' | 'retired'
  allocation: number
  source_experiment: number | null
  notes: string | null
}

export interface RiskEvent {
  id: number
  ts: string
  rule: string
  decision: string
  severity: string
  message: string
  order_id: number | null
  data: { checks?: { approved: boolean; rule: string; message: string }[] }
}

export interface GraphNode {
  id: string
  label: string
  kind: 'core' | 'agent' | 'risk' | 'paper' | 'forecast' | 'feature' | 'data' | 'strategy_type' | 'experiment' | 'deployed' | 'job' | 'run'
  [k: string]: unknown
}

export interface GraphData {
  nodes: GraphNode[]
  edges: { s: string; t: string; kind: string }[]
  generated_at: string
  provenance: string
}

export interface Overview {
  counts: Record<string, number>
  uptime_s: number
  code_version: string
  load_avg: number[] | null
  db_bytes: number
  autonomy: AutonomyStatus
  llm: { enabled: boolean; provider: string; reason?: string; model?: string }
  paper: Account
  kill_switch: boolean
  mode: string
}

export interface AutonomyConfig {
  enabled: boolean
  paused: boolean
  enabled_at: string | null
  schedule: 'daily' | 'interval' | 'manual'
  daily_time: string
  timezone: string
  interval_hours: number
  max_hypotheses_per_cycle: number
  max_cycles_per_day: number
  max_job_runtime_s: number
  max_data_requests_per_cycle: number
  monthly_cpu_budget_s: number
  monthly_llm_token_budget: number
  paper_tick_after_refresh: boolean
  auto_deploy_paper: boolean
}

export interface Usage { cpu_s: number; wall_s: number; data_requests: number; llm_tokens: number; rss_mb_peak?: number }

export interface AutonomyStatus {
  config: AutonomyConfig
  state: 'on' | 'paused' | 'off'
  running: boolean
  next_run_at: string | null
  last_cycle: { id: number; created_at: string; status: string; trigger: string } | null
  cycles_today: number
  active: { id: number; type: string; status: string }[]
  usage_month: Usage & { jobs: number }
  budget: { cpu_s: number; llm_tokens: number; cpu_remaining_s: number; llm_tokens_remaining: number }
  caps: Record<string, number>
  note: string
}

export interface CycleHistory {
  job_id: number
  trigger: 'manual' | 'schedule' | 'run_now' | string
  status: Job['status']
  created_at: string
  started_at: string | null
  finished_at: string | null
  attempts: number
  error: string | null
  estimate: { hypotheses?: number; cpu_s?: number; data_requests?: number; llm_tokens?: number; basis?: string }
  usage: Usage | null
  result: { cycle_id: number; hypotheses: number; evaluated: number; accepted: number | null; dispositions: Record<string, number> | null; report_id: number; legacy?: boolean } | null
}

export interface AwayReport {
  since: string
  until: string
  basis: string
  headline: string
  research: { cycles: number; by_status: Record<string, number>; by_trigger: Record<string, number>; ideas_tested: number; dispositions: Record<string, number>; trials_registered: number; holdout_looks: number; top_rejection_reasons: [string, number][]; notable: { experiment_id: number; symbol: string; strategy: string; disposition: string; q_value: number | null }[]; cycle_job_ids: number[] }
  paper: { orders: number; fills: number; risk_blocks: number; blocked: { risk_event_id: number; rule: string; message: string; order_id: number | null }[]; equity_start: number | null; equity_end: number | null; realized_pnl: number }
  data_issues: { id: number; ts: string; level: string; message: string }[]
  problems: { job_id: number; type: string; status: string; error: string }[]
  usage: { cpu_s: number; data_requests: number; llm_tokens: number }
  provenance: string
}
