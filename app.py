
import streamlit as st
import pandas as pd
import plotly.graph_objects as go
import requests
from datetime import date, timedelta

st.set_page_config(
    page_title="ATLAS AI | Forex Terminal",
    page_icon="📈",
    layout="wide"
)

st.markdown("""
<style>
.stApp {background: #080d18; color: #e7edf8;}
[data-testid="stMetric"] {
    background: #121d30;
    border: 1px solid #243750;
    border-radius: 12px;
    padding: 16px;
}
h1, h2, h3 {color: #e7edf8 !important;}
</style>
""", unsafe_allow_html=True)

@st.cache_data(ttl=3600)
def get_forex_data():
    start = (date.today() - timedelta(days=365)).isoformat()
    end = date.today().isoformat()
    url = f"https://api.frankfurter.dev/v1/{start}..{end}"
    response = requests.get(
        url,
        params={"base": "EUR", "symbols": "USD"},
        timeout=20
    )
    response.raise_for_status()
    rates = response.json()["rates"]
    df = pd.DataFrame([
        {"date": day, "close": value["USD"]}
        for day, value in rates.items()
    ])
    df["date"] = pd.to_datetime(df["date"])
    return df.sort_values("date").reset_index(drop=True)

st.title("ATLAS / FOREX INTELLIGENCE")
st.caption("Quantitative Research Terminal • Paper Trading Only")

try:
    df = get_forex_data()
except Exception as e:
    st.error(f"Market data unavailable: {e}")
    st.stop()

df["fast"] = df["close"].rolling(10).mean()
df["slow"] = df["close"].rolling(30).mean()
df["signal"] = (df["fast"] > df["slow"]).astype(int)
df["position"] = df["signal"].shift(1).fillna(0)
df["returns"] = df["close"].pct_change().fillna(0)

# Indicative long/flat backtest with simplified trading costs
df["turnover"] = df["position"].diff().abs().fillna(
    df["position"].abs()
)
df["strategy_return"] = (
    df["position"] * df["returns"]
    - df["turnover"] * 0.0001
)
df["equity"] = 10000 * (1 + df["strategy_return"]).cumprod()
df["peak"] = df["equity"].cummax()
df["drawdown"] = df["equity"] / df["peak"] - 1

latest = df.iloc[-1]
equity = float(latest["equity"])
return_pct = (equity / 10000 - 1) * 100
max_drawdown = float(df["drawdown"].min()) * 100

a, b, c, d = st.columns(4)
a.metric("EUR/USD", f'{latest["close"]:.5f}')
b.metric("Virtual Equity", f"${equity:,.2f}")
c.metric("Backtest Return", f"{return_pct:+.2f}%")
d.metric("Max Drawdown", f"{max_drawdown:.2f}%")

st.divider()

left, right = st.columns([3, 1])

with left:
    st.subheader("EUR/USD — Daily Reference Rates")
    fig = go.Figure()
    fig.add_trace(go.Scatter(
        x=df["date"], y=df["close"],
        name="EUR/USD", line=dict(color="#32e6da", width=2)
    ))
    fig.add_trace(go.Scatter(
        x=df["date"], y=df["fast"],
        name="MA 10", line=dict(color="#ffbe55")
    ))
    fig.add_trace(go.Scatter(
        x=df["date"], y=df["slow"],
        name="MA 30", line=dict(color="#b48cff")
    ))
    fig.update_layout(
        template="plotly_dark",
        paper_bgcolor="#080d18",
        plot_bgcolor="#101a2a",
        height=450,
        margin=dict(l=10, r=10, t=15, b=10)
    )
    st.plotly_chart(fig, use_container_width=True)

with right:
    st.subheader("Strategy Status")
    st.metric(
        "Latest Signal",
        "LONG" if latest["signal"] else "FLAT"
    )
    st.write("Strategy: MA 10 / MA 30")
    st.write("Mode: Historical simulation")
    st.write("Risk: No leverage")
    st.info("Signals use daily reference rates, not broker quotes.")

st.subheader("Simulated Equity Curve")
equity_fig = go.Figure()
equity_fig.add_trace(go.Scatter(
    x=df["date"], y=df["equity"],
    fill="tozeroy",
    name="Virtual Equity",
    line=dict(color="#32e6da")
))
equity_fig.update_layout(
    template="plotly_dark",
    paper_bgcolor="#080d18",
    plot_bgcolor="#101a2a",
    height=300
)
st.plotly_chart(equity_fig, use_container_width=True)

st.caption(
    "Research prototype. Historical backtest only. "
    "No live orders, no broker connection, no guaranteed returns."
)

3       