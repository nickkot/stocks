"use client";

import { useEffect, useMemo, useState } from "react";
import { LEVERAGED_TICKERS } from "@/lib/tickers";
import { bsCall, impliedVolCall, probSTAboveK } from "@/lib/blackScholes";
import { simulate, SimResult } from "@/lib/simulator";

type OptionRow = {
  contractSymbol: string;
  strike: number;
  bid: number;
  ask: number;
  last: number;
  mid: number;
  volume: number;
  openInterest: number;
  impliedVolatility: number;
  inTheMoney: boolean;
  pctOTM: number;
  expiration: number;
};

type ChainResp = {
  symbol: string;
  shortName: string;
  spot: number;
  expirations: number[];
  selectedExpiration: number;
  calls: OptionRow[];
  error?: string;
};

const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) : "—");
const pct = (n: number, d = 1) => (Number.isFinite(n) ? `${(n * 100).toFixed(d)}%` : "—");
const usd = (n: number) => (Number.isFinite(n) ? `$${fmt(n)}` : "—");
const dateStr = (epoch: number) => new Date(epoch * 1000).toISOString().slice(0, 10);

export default function Page() {
  const [symbol, setSymbol] = useState("SOXL");
  const [chain, setChain] = useState<ChainResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expDate, setExpDate] = useState<number | null>(null);

  const [minOTM, setMinOTM] = useState(30);   // %
  const [maxOTM, setMaxOTM] = useState(300);  // %
  const [minOI, setMinOI] = useState(0);

  const [selected, setSelected] = useState<OptionRow | null>(null);

  // Simulator inputs
  const [muAnnual, setMuAnnual] = useState(0.08);
  const [sigmaAnnual, setSigmaAnnual] = useState(0.30);
  const [expenseRatio, setExpenseRatio] = useState(0.0095);
  const [financingSpread, setFinancingSpread] = useState(0.005);
  const [riskFreeRate, setRiskFreeRate] = useState(0.045);
  const [contracts, setContracts] = useState(1);
  const [paths, setPaths] = useState(20000);
  const [targetMultiple, setTargetMultiple] = useState(100);

  const [simResult, setSimResult] = useState<SimResult | null>(null);
  const [simRunning, setSimRunning] = useState(false);

  const ticker = LEVERAGED_TICKERS.find(t => t.symbol === symbol);
  const leverage = ticker?.leverage ?? 3;

  async function loadChain(sym: string, date?: number) {
    setLoading(true); setErr(null);
    try {
      const url = new URL("/api/options", window.location.origin);
      url.searchParams.set("symbol", sym);
      if (date) url.searchParams.set("date", String(date));
      const res = await fetch(url.toString());
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setChain(json);
      setExpDate(json.selectedExpiration);
    } catch (e: any) {
      setErr(e.message);
      setChain(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadChain(symbol); /* eslint-disable-next-line */ }, []);

  function pickSymbol(sym: string) {
    setSymbol(sym);
    setSelected(null);
    setSimResult(null);
    loadChain(sym);
  }

  function pickExp(ts: number) {
    setExpDate(ts);
    setSelected(null);
    setSimResult(null);
    loadChain(symbol, ts);
  }

  const filteredCalls = useMemo(() => {
    if (!chain) return [];
    return chain.calls
      .filter(c => c.pctOTM * 100 >= minOTM && c.pctOTM * 100 <= maxOTM)
      .filter(c => (c.openInterest ?? 0) >= minOI)
      .filter(c => c.mid > 0)
      .sort((a, b) => a.strike - b.strike);
  }, [chain, minOTM, maxOTM, minOI]);

  // Decorate each row with derived metrics: T (years), IV, breakeven, multiple to 100x, P(reach strike), implied move.
  const rows = useMemo(() => {
    if (!chain) return [];
    const now = Date.now() / 1000;
    // Approximate leveraged-ETF dynamics under user's underlying assumptions.
    const muLev = leverage * muAnnual
      - (expenseRatio + financingSpread * (leverage - 1))
      - 0.5 * leverage * (leverage - 1) * sigmaAnnual * sigmaAnnual;
    const sigmaLev = leverage * sigmaAnnual;
    return filteredCalls.map(c => {
      const T = Math.max(1 / 365, (c.expiration - now) / (365 * 86400));
      const iv = c.impliedVolatility && c.impliedVolatility > 0
        ? c.impliedVolatility
        : impliedVolCall(c.mid, chain.spot, c.strike, T, riskFreeRate);
      const breakeven = c.strike + c.mid;
      const priceForTarget = c.strike + c.mid * targetMultiple;
      const moveToTarget = priceForTarget / chain.spot - 1;
      const probReachStrike = probSTAboveK(chain.spot, c.strike, T, muLev, sigmaLev);
      const probReachTarget = probSTAboveK(chain.spot, priceForTarget, T, muLev, sigmaLev);
      return { ...c, T, iv, breakeven, priceForTarget, moveToTarget, probReachStrike, probReachTarget };
    });
  }, [filteredCalls, chain, riskFreeRate, targetMultiple, muAnnual, sigmaAnnual, leverage, expenseRatio, financingSpread]);

  async function runSim() {
    if (!selected || !chain) return;
    setSimRunning(true);
    // Defer to next tick so UI can show "running"
    await new Promise(r => setTimeout(r, 30));
    const days = Math.max(1, Math.round((selected.expiration - Date.now() / 1000) / 86400));
    const iv = selected.impliedVolatility && selected.impliedVolatility > 0
      ? selected.impliedVolatility
      : impliedVolCall(selected.mid, chain.spot, selected.strike, days / 365, riskFreeRate);
    const result = simulate({
      spotUnderlying: chain.spot / leverage * leverage, // we model directly via leveraged compounding; underlying scale is irrelevant
      muAnnual,
      sigmaAnnual,
      leverage,
      expenseRatio,
      financingSpread,
      leveragedSpot: chain.spot,
      strike: selected.strike,
      daysToExpiry: days,
      optionPrice: selected.mid,
      contracts,
      riskFreeRate,
      optionIV: iv,
      paths,
      targetMultiple,
    });
    setSimResult(result);
    setSimRunning(false);
  }

  const maxHist = simResult ? Math.max(...simResult.histogram.map(h => h.count), 1) : 1;

  return (
    <div className="container">
      <div className="header">
        <div>
          <h1>Leveraged Options Lab</h1>
          <div className="sub">Far-OTM call hunting + Monte Carlo path-to-100x on 2x/3x leveraged ETFs</div>
        </div>
        <div className="sub">Live data · Yahoo Finance</div>
      </div>

      <div className="warningbox" style={{ marginBottom: 16 }}>
        Educational tool, not financial advice. Far-OTM calls on 3x ETFs combine three forms of decay
        (theta on the option, expense + financing on the ETF, and volatility decay from daily rebalancing).
        Most paths to 100x require a sustained, low-vol upward drift in the underlying — not a slow grind.
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h2>Pick a leveraged ETF</h2>
        <div className="row">
          {LEVERAGED_TICKERS.map(t => (
            <button key={t.symbol} className={t.symbol === symbol ? "" : "secondary"} onClick={() => pickSymbol(t.symbol)}>
              {t.symbol} <span style={{ opacity: 0.7, fontWeight: 400 }}>({t.leverage}x)</span>
            </button>
          ))}
        </div>
        {ticker && (
          <div style={{ marginTop: 10, color: "var(--muted)", fontSize: 12 }}>
            {ticker.name} · tracks {ticker.underlying} · {ticker.leverage}x daily
          </div>
        )}
      </div>

      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h2>Spot</h2>
          <div className="stat"><div className="v">{chain ? usd(chain.spot) : "—"}</div><div className="l">{symbol}</div></div>
        </div>
        <div className="panel">
          <h2>Expiration</h2>
          <div className="row">
            <div className="field">
              <label>Date</label>
              <select value={expDate ?? ""} onChange={e => pickExp(Number(e.target.value))}>
                {chain?.expirations?.map(ts => <option key={ts} value={ts}>{dateStr(ts)}</option>)}
              </select>
            </div>
          </div>
        </div>
        <div className="panel">
          <h2>Filter</h2>
          <div className="row">
            <div className="field"><label>Min %OTM</label><input type="number" value={minOTM} onChange={e => setMinOTM(Number(e.target.value))} /></div>
            <div className="field"><label>Max %OTM</label><input type="number" value={maxOTM} onChange={e => setMaxOTM(Number(e.target.value))} /></div>
            <div className="field"><label>Min OI</label><input type="number" value={minOI} onChange={e => setMinOI(Number(e.target.value))} /></div>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h2>Far-OTM call candidates {expDate ? `· ${dateStr(expDate)}` : ""}</h2>
        {loading && <div className="muted">Loading chain…</div>}
        {err && <div className="bad">Error: {err}</div>}
        {!loading && !err && rows.length === 0 && <div className="muted">No calls match those filters. Loosen %OTM range.</div>}
        {!loading && rows.length > 0 && (
          <div style={{ maxHeight: 480, overflow: "auto", borderRadius: 6, border: "1px solid var(--border)" }}>
            <table>
              <thead>
                <tr>
                  <th>Strike</th>
                  <th>%OTM</th>
                  <th>Mid</th>
                  <th>Bid/Ask</th>
                  <th>IV</th>
                  <th>OI</th>
                  <th>Vol</th>
                  <th>Breakeven</th>
                  <th>Need for {targetMultiple}x</th>
                  <th>Move to {targetMultiple}x</th>
                  <th>P(reach strike)</th>
                  <th>P(hit {targetMultiple}x)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.contractSymbol} className={selected?.contractSymbol === r.contractSymbol ? "selected" : ""} onClick={() => setSelected(r)}>
                    <td>{usd(r.strike)}</td>
                    <td>{pct(r.pctOTM)}</td>
                    <td>{usd(r.mid)}</td>
                    <td className="muted">{fmt(r.bid)} / {fmt(r.ask)}</td>
                    <td>{pct(r.iv)}</td>
                    <td>{r.openInterest}</td>
                    <td>{r.volume}</td>
                    <td>{usd(r.breakeven)}</td>
                    <td>{usd(r.priceForTarget)}</td>
                    <td className={r.moveToTarget > 5 ? "warn" : "good"}>{pct(r.moveToTarget)}</td>
                    <td>{pct(r.probReachStrike)}</td>
                    <td className={r.probReachTarget > 0.01 ? "good" : "muted"}>{pct(r.probReachTarget, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h2>Selected contract</h2>
          {!selected && <div className="muted">Click a row to load it into the simulator.</div>}
          {selected && chain && (
            <div className="grid cols-2" style={{ gap: 12 }}>
              <div className="stat"><div className="v">{selected.contractSymbol}</div><div className="l">contract</div></div>
              <div className="stat"><div className="v">{usd(selected.strike)}</div><div className="l">strike</div></div>
              <div className="stat"><div className="v">{usd(selected.mid)}</div><div className="l">premium (mid)</div></div>
              <div className="stat"><div className="v">{pct(selected.pctOTM)}</div><div className="l">% OTM</div></div>
              <div className="stat"><div className="v">{pct(selected.impliedVolatility)}</div><div className="l">implied vol</div></div>
              <div className="stat"><div className="v">{dateStr(selected.expiration)}</div><div className="l">expiry</div></div>
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Simulation assumptions</h2>
          <div className="row">
            <div className="field"><label>Underlying drift μ (annual)</label><input type="number" step="0.01" value={muAnnual} onChange={e => setMuAnnual(Number(e.target.value))} /></div>
            <div className="field"><label>Underlying vol σ (annual)</label><input type="number" step="0.01" value={sigmaAnnual} onChange={e => setSigmaAnnual(Number(e.target.value))} /></div>
            <div className="field"><label>ETF expense ratio</label><input type="number" step="0.0005" value={expenseRatio} onChange={e => setExpenseRatio(Number(e.target.value))} /></div>
            <div className="field"><label>Financing spread</label><input type="number" step="0.0005" value={financingSpread} onChange={e => setFinancingSpread(Number(e.target.value))} /></div>
            <div className="field"><label>Risk-free r</label><input type="number" step="0.005" value={riskFreeRate} onChange={e => setRiskFreeRate(Number(e.target.value))} /></div>
            <div className="field"><label>Contracts</label><input type="number" value={contracts} onChange={e => setContracts(Number(e.target.value))} /></div>
            <div className="field"><label>Paths</label><input type="number" step="1000" value={paths} onChange={e => setPaths(Number(e.target.value))} /></div>
            <div className="field"><label>Target multiple</label><input type="number" value={targetMultiple} onChange={e => setTargetMultiple(Number(e.target.value))} /></div>
          </div>
          <div style={{ marginTop: 12 }}>
            <button onClick={runSim} disabled={!selected || simRunning}>{simRunning ? "Simulating…" : `Run Monte Carlo (${paths.toLocaleString()} paths)`}</button>
          </div>
        </div>
      </div>

      {simResult && selected && chain && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h2>Simulation result</h2>
          <div className="grid cols-3" style={{ gap: 12 }}>
            <div className="stat"><div className="v good">{pct(simResult.probTargetMultiple, 2)}</div><div className="l">P(reach {targetMultiple}x)</div></div>
            <div className="stat"><div className="v">{pct(simResult.probTenX, 2)}</div><div className="l">P(reach 10x)</div></div>
            <div className="stat"><div className="v">{pct(simResult.probDoubles, 2)}</div><div className="l">P(double)</div></div>
            <div className="stat"><div className="v">{pct(simResult.probInTheMoney, 1)}</div><div className="l">P(ITM at expiry)</div></div>
            <div className="stat"><div className="v">{usd(simResult.endingLeveragedPrice.p50)}</div><div className="l">{symbol} median at expiry</div></div>
            <div className="stat"><div className="v">{usd(simResult.endingLeveragedPrice.p95)}</div><div className="l">{symbol} 95th pct</div></div>
            <div className="stat"><div className="v">{fmt(simResult.payoffMultiple.mean)}x</div><div className="l">mean payoff multiple</div></div>
            <div className="stat"><div className="v">{fmt(simResult.payoffMultiple.p95)}x</div><div className="l">95th pct payoff</div></div>
            <div className="stat"><div className="v">{pct(simResult.leveragedMoveForTarget)}</div><div className="l">{symbol} move needed for {targetMultiple}x</div></div>
          </div>

          <div style={{ marginTop: 16 }}>
            <h2>Distribution of payoff multiples</h2>
            <div className="histbar">
              {simResult.histogram.map(h => (
                <div key={h.bucket} className="bar" data-tip={`${h.bucket}: ${h.count}`} style={{ height: `${(h.count / maxHist) * 100}%` }} />
              ))}
            </div>
            <div className="histlabels">
              {simResult.histogram.map(h => <span key={h.bucket}>{h.bucket}</span>)}
            </div>
          </div>

          <div className="warningbox" style={{ marginTop: 16 }}>
            Model: underlying GBM with drift μ and vol σ; leveraged ETF compounded daily as <code>L · r_under − (expense + financing·(L−1))/252</code>;
            option payoff is intrinsic at expiry. Volatility decay emerges from the path. Try σ = 0.25 (S&P-like) vs 0.40 (semis-like) and see how the probability of 100x collapses with σ.
          </div>
        </div>
      )}

      <div className="panel">
        <h2>Theoretical helpers</h2>
        {chain && selected && (
          <div className="grid cols-3">
            <div className="stat">
              <div className="v">{usd(bsCall(chain.spot, selected.strike, Math.max(1/365, (selected.expiration - Date.now()/1000)/(365*86400)), riskFreeRate, selected.impliedVolatility || 0.6))}</div>
              <div className="l">BS price @ current IV</div>
            </div>
            <div className="stat">
              <div className="v">{pct(impliedVolCall(selected.mid, chain.spot, selected.strike, Math.max(1/365,(selected.expiration - Date.now()/1000)/(365*86400)), riskFreeRate))}</div>
              <div className="l">Solved IV from mid</div>
            </div>
            <div className="stat">
              <div className="v">{fmt((selected.mid * targetMultiple) / Math.max(0.01, chain.spot - selected.strike + selected.mid))}x</div>
              <div className="l">leverage at expiry per $ underlying</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
