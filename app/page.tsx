"use client";

import { useMemo, useState } from "react";
import { LEVERAGED_TICKERS } from "@/lib/tickers";
import { bsCall, impliedVolCall, probSTAboveK, probTouchUpperBarrier, spotForCallPrice } from "@/lib/blackScholes";
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
  const [touchMultiple, setTouchMultiple] = useState(2);

  const [simResult, setSimResult] = useState<SimResult | null>(null);
  const [simRunning, setSimRunning] = useState(false);

  // Manual mode (used when the data feed is unavailable, e.g. Yahoo blocking Vercel).
  const [manualMode, setManualMode] = useState(false);
  const [mSpot, setMSpot] = useState(25);
  const [mStrike, setMStrike] = useState(50);
  const [mPremium, setMPremium] = useState(0.10);
  const [mIV, setMIV] = useState(0.85);
  const [mDays, setMDays] = useState(180);

  const ticker = LEVERAGED_TICKERS.find(t => t.symbol === symbol);
  const leverage = ticker?.leverage ?? 3;

  const [allExpirations, setAllExpirations] = useState(false);

  async function loadChain(sym: string, date?: number, force = false, all = allExpirations) {
    if (loading) return; // single-flight: ignore overlapping clicks
    setLoading(true); setErr(null);
    try {
      const url = new URL("/api/options", window.location.origin);
      url.searchParams.set("symbol", sym);
      if (date && !all) url.searchParams.set("date", String(date));
      if (force) url.searchParams.set("force", "1");
      if (all) url.searchParams.set("all", "1");
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

  // No auto-fetch on mount: spare the upstream API and avoid surprise rate-limits.

  function pickSymbol(sym: string) {
    setSymbol(sym);
    setSelected(null);
    setSimResult(null);
    setChain(null);   // clear stale chain so user explicitly chooses to load
  }

  function pickExp(ts: number) {
    setExpDate(ts);
    setSelected(null);
    setSimResult(null);
    loadChain(symbol, ts);
  }

  const [requireQuote, setRequireQuote] = useState(true);

  const filteredCalls = useMemo(() => {
    if (!chain) return [];
    return chain.calls
      .filter(c => c.pctOTM * 100 >= minOTM && c.pctOTM * 100 <= maxOTM)
      .filter(c => (c.openInterest ?? 0) >= minOI)
      .filter(c => !requireQuote || c.mid > 0)
      .sort((a, b) => a.strike - b.strike);
  }, [chain, minOTM, maxOTM, minOI, requireQuote]);

  // Diagnostics for the empty state.
  const filterDiag = useMemo(() => {
    if (!chain) return null;
    const total = chain.calls.length;
    const otmPass = chain.calls.filter(c => c.pctOTM * 100 >= minOTM && c.pctOTM * 100 <= maxOTM).length;
    const oiPass = chain.calls.filter(c => (c.openInterest ?? 0) >= minOI).length;
    const quotePass = chain.calls.filter(c => c.mid > 0).length;
    const minOTMActual = total ? Math.min(...chain.calls.map(c => c.pctOTM * 100)) : 0;
    const maxOTMActual = total ? Math.max(...chain.calls.map(c => c.pctOTM * 100)) : 0;
    return { total, otmPass, oiPass, quotePass, minOTMActual, maxOTMActual };
  }, [chain, minOTM, maxOTM, minOI]);

  // Sort selector for the candidates table.
  type SortKey = "leverageAtPlus100" | "leverageAtPlus50" | "moveToTarget" | "probTarget" | "probTouch" | "cheapest" | "strike";
  const [sortKey, setSortKey] = useState<SortKey>("leverageAtPlus100");

  // Decorate each row with derived metrics.
  const rows = useMemo(() => {
    if (!chain) return [];
    const now = Date.now() / 1000;
    const muLev = leverage * muAnnual
      - (expenseRatio + financingSpread * (leverage - 1))
      - 0.5 * leverage * (leverage - 1) * sigmaAnnual * sigmaAnnual;
    const sigmaLev = leverage * sigmaAnnual;
    const decorated = filteredCalls.map(c => {
      const T = Math.max(1 / 365, (c.expiration - now) / (365 * 86400));
      const iv = c.impliedVolatility && c.impliedVolatility > 0
        ? c.impliedVolatility
        : impliedVolCall(c.mid, chain.spot, c.strike, T, riskFreeRate);
      const breakeven = c.strike + c.mid;
      const priceForTarget = c.strike + c.mid * targetMultiple;
      const moveToTarget = priceForTarget / chain.spot - 1;
      const probReachStrike = probSTAboveK(chain.spot, c.strike, T, muLev, sigmaLev);
      const probReachTarget = probSTAboveK(chain.spot, priceForTarget, T, muLev, sigmaLev);
      // Leverage = payoff multiple at expiry given a fixed move in the leveraged ETF (intrinsic only).
      const payoffMult = (movePct: number) => {
        const finalPrice = chain.spot * (1 + movePct);
        const intrinsic = Math.max(0, finalPrice - c.strike);
        return c.mid > 0 ? intrinsic / c.mid : 0;
      };
      const leverageAtPlus50 = payoffMult(0.5);
      const leverageAtPlus100 = payoffMult(1.0);
      const leverageAtPlus200 = payoffMult(2.0);
      // Spot level needed today (at current IV/T) for the contract's mark to equal touchMultiple × premium.
      const ivForTouch = iv > 0 ? iv : 0.5;
      const barrier = spotForCallPrice(touchMultiple * c.mid, c.strike, T, riskFreeRate, ivForTouch);
      const probTouchMult = Number.isFinite(barrier) && barrier > 0
        ? probTouchUpperBarrier(chain.spot, barrier, T, muLev, sigmaLev)
        : 0;
      return {
        ...c, T, iv, breakeven, priceForTarget, moveToTarget,
        probReachStrike, probReachTarget,
        leverageAtPlus50, leverageAtPlus100, leverageAtPlus200,
        barrier, probTouchMult,
      };
    });
    const cmp: Record<SortKey, (a: any, b: any) => number> = {
      leverageAtPlus100: (a, b) => b.leverageAtPlus100 - a.leverageAtPlus100,
      leverageAtPlus50:  (a, b) => b.leverageAtPlus50  - a.leverageAtPlus50,
      moveToTarget:      (a, b) => a.moveToTarget      - b.moveToTarget,
      probTarget:        (a, b) => b.probReachTarget   - a.probReachTarget,
      probTouch:         (a, b) => b.probTouchMult     - a.probTouchMult,
      cheapest:          (a, b) => a.mid               - b.mid,
      strike:            (a, b) => a.strike            - b.strike,
    };
    return decorated.sort(cmp[sortKey]);
  }, [filteredCalls, chain, riskFreeRate, targetMultiple, touchMultiple, muAnnual, sigmaAnnual, leverage, expenseRatio, financingSpread, sortKey]);

  async function runSim() {
    setSimRunning(true);
    await new Promise(r => setTimeout(r, 30));
    const useManual = manualMode || !selected || !chain;
    const spotPrice = useManual ? mSpot : chain!.spot;
    const strike = useManual ? mStrike : selected!.strike;
    const premium = useManual ? mPremium : selected!.mid;
    const days = useManual
      ? Math.max(1, mDays)
      : Math.max(1, Math.round((selected!.expiration - Date.now() / 1000) / 86400));
    const iv = useManual
      ? mIV
      : selected!.impliedVolatility && selected!.impliedVolatility > 0
        ? selected!.impliedVolatility
        : impliedVolCall(premium, spotPrice, strike, days / 365, riskFreeRate);
    const result = simulate({
      spotUnderlying: spotPrice,
      muAnnual,
      sigmaAnnual,
      leverage,
      expenseRatio,
      financingSpread,
      leveragedSpot: spotPrice,
      strike,
      daysToExpiry: days,
      optionPrice: premium,
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

      {err && (
        <div className="warningbox" style={{ marginBottom: 16, background: "#2a0a0a", borderColor: "#5a1a1a", color: "#fecaca" }}>
          <strong>Live feed unavailable.</strong> {err}
          <div style={{ marginTop: 6, color: "#fca5a5" }}>
            Yahoo Finance blocks Vercel egress with HTTP 429. Two fixes: (1) set a free <code>TRADIER_TOKEN</code> env var
            in Vercel (<a href="https://developer.tradier.com/user/sign_up" target="_blank" rel="noreferrer">developer.tradier.com</a>) then redeploy,
            or (2) toggle <em>Manual mode</em> below and paste contract details from your broker.
          </div>
        </div>
      )}

      <div className="panel" style={{ marginBottom: 16 }}>
        <h2>Mode</h2>
        <div className="row">
          <button className={!manualMode ? "" : "secondary"} onClick={() => setManualMode(false)}>Live feed</button>
          <button className={manualMode ? "" : "secondary"} onClick={() => setManualMode(true)}>Manual entry</button>
          <div className="muted" style={{ alignSelf: "center", fontSize: 12 }}>
            Manual mode lets you simulate any contract by typing its details — no data feed needed.
          </div>
        </div>
        {manualMode && (
          <div className="row" style={{ marginTop: 12 }}>
            <div className="field"><label>{symbol} spot ($)</label><input type="number" step="0.01" value={mSpot} onChange={e => setMSpot(Number(e.target.value))} /></div>
            <div className="field"><label>Strike ($)</label><input type="number" step="0.5" value={mStrike} onChange={e => setMStrike(Number(e.target.value))} /></div>
            <div className="field"><label>Premium ($)</label><input type="number" step="0.01" value={mPremium} onChange={e => setMPremium(Number(e.target.value))} /></div>
            <div className="field"><label>IV (decimal)</label><input type="number" step="0.05" value={mIV} onChange={e => setMIV(Number(e.target.value))} /></div>
            <div className="field"><label>Days to expiry</label><input type="number" value={mDays} onChange={e => setMDays(Number(e.target.value))} /></div>
          </div>
        )}
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
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={() => loadChain(symbol)} disabled={loading || manualMode}>
            {loading ? "Loading…" : chain ? `Reload ${symbol} chain` : `Load ${symbol} chain`}
          </button>
          {chain && (
            <button className="secondary" onClick={() => loadChain(symbol, expDate ?? undefined, true)} disabled={loading}>
              Force refresh (skip cache)
            </button>
          )}
          <label className="muted" style={{ alignSelf: "center", fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={allExpirations}
              onChange={e => {
                const v = e.target.checked;
                setAllExpirations(v);
                if (chain) loadChain(symbol, undefined, false, v);
              }}
            />
            All expirations (cross-date table)
          </label>
          <div className="muted" style={{ alignSelf: "center", fontSize: 12 }}>
            Cached 10 min server-side.
          </div>
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
              <label>{allExpirations ? "Mode" : "Date"}</label>
              {allExpirations ? (
                <div style={{ alignSelf: "center", fontSize: 13 }}>
                  All expirations ({chain?.expirations?.length ?? 0}) · {chain?.calls?.length ?? 0} contracts
                </div>
              ) : (
                <select value={expDate ?? ""} onChange={e => pickExp(Number(e.target.value))}>
                  {chain?.expirations?.map(ts => <option key={ts} value={ts}>{dateStr(ts)}</option>)}
                </select>
              )}
            </div>
          </div>
        </div>
        <div className="panel">
          <h2>Filter</h2>
          <div className="row">
            <div className="field"><label>Min %OTM</label><input type="number" value={minOTM} onChange={e => setMinOTM(Number(e.target.value))} /></div>
            <div className="field"><label>Max %OTM</label><input type="number" value={maxOTM} onChange={e => setMaxOTM(Number(e.target.value))} /></div>
            <div className="field"><label>Min OI</label><input type="number" value={minOI} onChange={e => setMinOI(Number(e.target.value))} /></div>
            <div className="field" style={{ minWidth: 140 }}>
              <label>Require live quote</label>
              <select value={requireQuote ? "1" : "0"} onChange={e => setRequireQuote(e.target.value === "1")}>
                <option value="1">Yes (mid &gt; 0)</option>
                <option value="0">No (show all strikes)</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h2>Far-OTM call candidates {allExpirations ? "· all expirations" : (expDate ? `· ${dateStr(expDate)}` : "")}</h2>
        {chain && rows.length > 0 && (
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="field" style={{ minWidth: 240 }}>
              <label>Sort by</label>
              <select value={sortKey} onChange={e => setSortKey(e.target.value as any)}>
                <option value="probTouch">Highest P(touch {touchMultiple}x anytime)</option>
                <option value="leverageAtPlus100">Highest leverage if {symbol} doubles (+100%)</option>
                <option value="leverageAtPlus50">Highest leverage if {symbol} +50%</option>
                <option value="probTarget">Highest P(hit {targetMultiple}x at expiry)</option>
                <option value="moveToTarget">Smallest move needed for {targetMultiple}x</option>
                <option value="cheapest">Cheapest premium</option>
                <option value="strike">Strike (low → high)</option>
              </select>
            </div>
            <div className="field" style={{ minWidth: 140 }}>
              <label>Touch multiple</label>
              <input type="number" step="0.5" min="1.1" value={touchMultiple} onChange={e => setTouchMultiple(Math.max(1.1, Number(e.target.value)))} />
            </div>
          </div>
        )}
        {loading && <div className="muted">Loading chain…</div>}
        {err && <div className="bad">Error: {err}</div>}
        {!loading && !err && !chain && (
          <div className="muted">Pick a ticker above and click <strong>Load chain</strong>.</div>
        )}
        {!loading && !err && chain && rows.length === 0 && filterDiag && (
          <div className="muted" style={{ lineHeight: 1.6 }}>
            <strong>{filterDiag.total}</strong> calls returned for {chain.symbol} on {expDate ? dateStr(expDate) : "—"} (spot {usd(chain.spot)}).<br />
            • {filterDiag.otmPass} pass the {minOTM}–{maxOTM}% OTM filter (chain has strikes from {filterDiag.minOTMActual.toFixed(0)}% to {filterDiag.maxOTMActual.toFixed(0)}% OTM)<br />
            • {filterDiag.oiPass} pass min OI ≥ {minOI}<br />
            • {filterDiag.quotePass} have a non-zero mid quote{requireQuote ? " (required)" : " (not required)"}<br />
            <span style={{ color: "var(--warn)" }}>Tip: widen %OTM to 0–500, or set "Require live quote" to No to see strikes without market quotes.</span>
          </div>
        )}
        {!loading && rows.length > 0 && (
          <div style={{ maxHeight: 480, overflow: "auto", borderRadius: 6, border: "1px solid var(--border)" }}>
            <table>
              <thead>
                <tr>
                  {allExpirations && <th>Exp</th>}
                  {allExpirations && <th title="Days to expiration">DTE</th>}
                  <th>Strike</th>
                  <th>%OTM</th>
                  <th>Mid</th>
                  <th>Bid/Ask</th>
                  <th>IV</th>
                  <th>OI</th>
                  <th title="Payoff multiple at expiry if the leveraged ETF moves +50%">Mult @+50%</th>
                  <th title="Payoff multiple at expiry if the leveraged ETF doubles (+100%)">Mult @+100%</th>
                  <th title="Payoff multiple at expiry if the leveraged ETF triples (+200%)">Mult @+200%</th>
                  <th>Breakeven</th>
                  <th title={`Leveraged-ETF price at expiry needed to make this contract worth ${targetMultiple}x its premium`}>Price for {targetMultiple}x</th>
                  <th title={`Percent move in the leveraged ETF from today's spot needed to hit ${targetMultiple}x`}>Move to {targetMultiple}x</th>
                  <th title={`Probability the option's mark hits ${touchMultiple}x its current premium at any point before expiry (you can sell anytime). Computed as first-passage probability of the underlying touching the spot level that prices the call at ${touchMultiple}x today, holding IV constant.`}>P(touch {touchMultiple}x)</th>
                  <th>P(hit {targetMultiple}x at expiry)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.contractSymbol} className={selected?.contractSymbol === r.contractSymbol ? "selected" : ""} onClick={() => setSelected(r)}>
                    {allExpirations && <td>{dateStr(r.expiration)}</td>}
                    {allExpirations && <td className="muted">{Math.round(r.T * 365)}</td>}
                    <td>{usd(r.strike)}</td>
                    <td>{pct(r.pctOTM)}</td>
                    <td>{usd(r.mid)}</td>
                    <td className="muted">{fmt(r.bid)} / {fmt(r.ask)}</td>
                    <td>{pct(r.iv)}</td>
                    <td>{r.openInterest}</td>
                    <td className={r.leverageAtPlus50  >= 1 ? "good" : "muted"}>{fmt(r.leverageAtPlus50)}x</td>
                    <td className={r.leverageAtPlus100 >= 5 ? "good" : "muted"}>{fmt(r.leverageAtPlus100)}x</td>
                    <td className={r.leverageAtPlus200 >= 20 ? "good" : "muted"}>{fmt(r.leverageAtPlus200)}x</td>
                    <td>{usd(r.breakeven)}</td>
                    <td>{usd(r.priceForTarget)}</td>
                    <td className={r.moveToTarget > 5 ? "warn" : "good"}>{pct(r.moveToTarget)}</td>
                    <td className={r.probTouchMult > 0.05 ? "good" : "muted"}>{pct(r.probTouchMult, 2)}</td>
                    <td className={r.probReachTarget > 0.01 ? "good" : "muted"}>{pct(r.probReachTarget, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {chain && rows.length > 0 && (
          <details style={{ marginTop: 12, color: "var(--muted)", fontSize: 12, lineHeight: 1.6 }}>
            <summary style={{ cursor: "pointer", color: "var(--text)" }}>What do these columns mean?</summary>
            <div style={{ marginTop: 8 }}>
              <strong>Mult @+50% / +100% / +200%</strong> — payoff multiple at expiry if {symbol} ends +50/100/200% from today. Computed as <code>max(0, spot·(1+move) − strike) / premium</code>. This is the leverage you actually get for a given move. Sort by these to find the most-leveraged contract for your scenario.<br/>
              <strong>Breakeven</strong> — strike + premium. If {symbol} is exactly here at expiry, you get back what you paid.<br/>
              <strong>Price for {targetMultiple}x</strong> — the {symbol} price at expiry that makes this contract worth <code>{targetMultiple} × premium</code>. Formula: <code>strike + {targetMultiple} × premium</code>.<br/>
              <strong>Move to {targetMultiple}x</strong> — that price expressed as a percent move from today's spot.<br/>
              <strong>P(touch {touchMultiple}x)</strong> — probability the contract's mark reaches <code>{touchMultiple} × premium</code> at <em>any</em> point before expiry, assuming you'd sell when it gets there. First-passage barrier is the spot level that prices the call at {touchMultiple}× today (Black-Scholes inversion holding IV constant); the closed form is the reflection-principle formula for GBM hitting an upper barrier with leveraged-ETF drift/vol. Always ≥ P(hit at expiry) since touch can happen earlier.<br/>
              <strong>P(hit {targetMultiple}x at expiry)</strong> — probability the contract is worth ≥ {targetMultiple}× premium <em>at expiration</em> (intrinsic value only; no path-dependence). Lower than the touch probability for the same multiple. Click a row for a full Monte Carlo.<br/>
              <em>Trade-off:</em> the most-leveraged contracts (highest Mult @+200%) are usually the deepest OTM with the lowest probability — that's the whole point. Sort by leverage to find the lottery tickets, then run the simulator on the most realistic ones.
            </div>
          </details>
        )}
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h2>Selected contract</h2>
          {manualMode ? (
            <div className="grid cols-2" style={{ gap: 12 }}>
              <div className="stat"><div className="v">Manual</div><div className="l">mode</div></div>
              <div className="stat"><div className="v">{usd(mStrike)}</div><div className="l">strike</div></div>
              <div className="stat"><div className="v">{usd(mPremium)}</div><div className="l">premium</div></div>
              <div className="stat"><div className="v">{pct(mStrike / mSpot - 1)}</div><div className="l">% OTM</div></div>
              <div className="stat"><div className="v">{pct(mIV)}</div><div className="l">implied vol</div></div>
              <div className="stat"><div className="v">{mDays}d</div><div className="l">to expiry</div></div>
            </div>
          ) : !selected ? (
            <div className="muted">Click a row to load it into the simulator.</div>
          ) : chain && (
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
            <button onClick={runSim} disabled={(!manualMode && !selected) || simRunning}>{simRunning ? "Simulating…" : `Run Monte Carlo (${paths.toLocaleString()} paths)`}</button>
          </div>
        </div>
      </div>

      {simResult && (manualMode || (selected && chain)) && (
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
