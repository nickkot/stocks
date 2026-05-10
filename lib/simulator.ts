import { bsCall, IvSurface, lookupIv } from "./blackScholes";

// Box-Muller standard normal.
function randn(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export type SimInput = {
  // Underlying (1x) parameters
  spotUnderlying: number;     // S0 of the underlying index/ETF the leveraged fund tracks (use leveragedSpot/leverage if unknown)
  muAnnual: number;            // expected drift of underlying (e.g. 0.08)
  sigmaAnnual: number;         // annual vol of underlying (e.g. 0.25)
  leverage: number;            // 2 or 3
  expenseRatio: number;        // annual fee on leveraged fund (e.g. 0.0095)
  financingSpread: number;     // implicit financing/borrow drag on the leveraged fund (e.g. 0.005)

  // Option parameters
  leveragedSpot: number;       // current price of leveraged ETF
  strike: number;              // option strike
  daysToExpiry: number;        // calendar days
  optionPrice: number;         // current ask/mid premium per share
  contracts: number;           // number of contracts (100 shares each)
  riskFreeRate: number;        // for theoretical pricing
  optionIV: number;            // implied vol used to value option at intermediate steps (we mark to BS at expiry only)

  paths: number;               // monte carlo paths
  targetMultiple: number;      // e.g. 100 for 100x
  ivSurface?: IvSurface;       // optional term-structure-aware IV surface for intermediate marks
};

export type SimResult = {
  endingLeveragedPrice: { p5: number; p50: number; p95: number; mean: number };
  endingOptionValue: { p5: number; p50: number; p95: number; mean: number };
  payoffMultiple: { p5: number; p50: number; p95: number; mean: number };       // multiple at expiry
  peakPayoffMultiple: { p5: number; p50: number; p95: number; mean: number };   // max multiple ever reached on the path (theoretical mark)
  probInTheMoney: number;
  probDoubles: number;
  probTenX: number;
  probTargetMultiple: number;          // P(multiple >= target at expiry)
  probPeakDoubles: number;             // P(peak multiple ever >= 2)
  probPeakTenX: number;                // P(peak multiple ever >= 10)
  probPeakTarget: number;              // P(peak multiple ever >= target)
  underlyingMoveForTarget: number;
  leveragedMoveForTarget: number;
  histogram: { bucket: string; count: number }[];   // distribution of PEAK multiples (sold at optimal moment)
  expiryHistogram: { bucket: string; count: number }[];  // distribution of multiples AT EXPIRY
};

const TRADING_DAYS_PER_YEAR = 252;

// Path-simulate the underlying daily, then compound 3x (or Lx) daily into the leveraged ETF
// to capture volatility decay. At expiry, the option payoff is intrinsic (European-style approximation).
export function simulate(input: SimInput): SimResult {
  const tradingDays = Math.max(1, Math.round((input.daysToExpiry / 365) * TRADING_DAYS_PER_YEAR));
  const dt = 1 / TRADING_DAYS_PER_YEAR;
  const muUnder = input.muAnnual;
  const sigUnder = input.sigmaAnnual;
  const L = input.leverage;
  const dailyDrag = (input.expenseRatio + input.financingSpread * Math.max(0, L - 1)) / TRADING_DAYS_PER_YEAR;

  const endingLev: number[] = new Array(input.paths);
  const endingOpt: number[] = new Array(input.paths);
  const multiples: number[] = new Array(input.paths);
  const peakMultiples: number[] = new Array(input.paths);

  let itm = 0, doubles = 0, tenx = 0, hit = 0;
  let peakDoubles = 0, peakTenX = 0, peakHit = 0;
  const premiumPerContract = input.optionPrice * 100;
  const totalPremium = premiumPerContract * input.contracts;
  // Mark intermediate option value with constant IV (input.optionIV) and shrinking time-to-expiry.
  const sigmaForMark = input.optionIV > 0 ? input.optionIV : 0.6;

  for (let i = 0; i < input.paths; i++) {
    let levPrice = input.leveragedSpot;
    let underPrice = input.spotUnderlying;
    let peakOptValue = input.optionPrice; // bsCall at t=0 ≈ current premium; peak can't be less than entry (we'd just hold)
    for (let d = 0; d < tradingDays; d++) {
      const z = randn();
      const dailyReturnUnder = (muUnder - 0.5 * sigUnder * sigUnder) * dt + sigUnder * Math.sqrt(dt) * z;
      const newUnder = underPrice * Math.exp(dailyReturnUnder);
      const underRet = newUnder / underPrice - 1;
      const leveragedDailyRet = L * underRet - dailyDrag;
      levPrice = Math.max(0.01, levPrice * (1 + leveragedDailyRet));
      underPrice = newUnder;
      // Theoretical mark of the option after this day's move, using remaining time.
      // If an IV surface is provided, look up IV at (T_remain, ln(K/levPrice)); else use the contract's IV.
      const remainingDays = tradingDays - d - 1;
      const T_remain = Math.max(1 / 365, remainingDays / TRADING_DAYS_PER_YEAR);
      const sigmaStep = input.ivSurface
        ? lookupIv(input.ivSurface, T_remain, Math.log(input.strike / levPrice))
        : sigmaForMark;
      const mark = bsCall(levPrice, input.strike, T_remain, input.riskFreeRate, sigmaStep);
      if (mark > peakOptValue) peakOptValue = mark;
    }
    const intrinsic = Math.max(0, levPrice - input.strike) * 100 * input.contracts;
    endingLev[i] = levPrice;
    endingOpt[i] = intrinsic;
    const mult = totalPremium > 0 ? intrinsic / totalPremium : 0;
    multiples[i] = mult;
    const peakMult = input.optionPrice > 0 ? peakOptValue / input.optionPrice : 0;
    peakMultiples[i] = peakMult;
    if (levPrice > input.strike) itm++;
    if (mult >= 2) doubles++;
    if (mult >= 10) tenx++;
    if (mult >= input.targetMultiple) hit++;
    if (peakMult >= 2) peakDoubles++;
    if (peakMult >= 10) peakTenX++;
    if (peakMult >= input.targetMultiple) peakHit++;
  }

  const sorted = (arr: number[]) => [...arr].sort((a, b) => a - b);
  const pct = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * arr.length)))];
  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;

  const sLev = sorted(endingLev);
  const sOpt = sorted(endingOpt);
  const sMul = sorted(multiples);
  const sPeak = sorted(peakMultiples);

  // Move needed in leveraged ETF for option to be worth targetMultiple of premium at expiry
  const targetIntrinsicPerShare = input.optionPrice * input.targetMultiple;
  const targetLevPrice = input.strike + targetIntrinsicPerShare;
  const leveragedMoveForTarget = targetLevPrice / input.leveragedSpot - 1;
  // Map leveraged move back to a single-shot underlying move (no decay, instantaneous): r_lev ~= L * r_under
  const underlyingMoveForTarget = leveragedMoveForTarget / L;

  // Log-bucketed histograms.
  const buckets = [0, 0.1, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
  const makeHist = (samples: number[]) => buckets.map((b, i) => {
    const next = buckets[i + 1] ?? Infinity;
    const count = samples.filter(m => m >= b && m < next).length;
    const label = next === Infinity ? `${b}x+` : `${b}-${next}x`;
    return { bucket: label, count };
  });

  return {
    endingLeveragedPrice: { p5: pct(sLev, 0.05), p50: pct(sLev, 0.5), p95: pct(sLev, 0.95), mean: mean(sLev) },
    endingOptionValue:    { p5: pct(sOpt, 0.05), p50: pct(sOpt, 0.5), p95: pct(sOpt, 0.95), mean: mean(sOpt) },
    payoffMultiple:       { p5: pct(sMul, 0.05), p50: pct(sMul, 0.5), p95: pct(sMul, 0.95), mean: mean(sMul) },
    peakPayoffMultiple:   { p5: pct(sPeak, 0.05), p50: pct(sPeak, 0.5), p95: pct(sPeak, 0.95), mean: mean(sPeak) },
    probInTheMoney: itm / input.paths,
    probDoubles: doubles / input.paths,
    probTenX: tenx / input.paths,
    probTargetMultiple: hit / input.paths,
    probPeakDoubles: peakDoubles / input.paths,
    probPeakTenX: peakTenX / input.paths,
    probPeakTarget: peakHit / input.paths,
    underlyingMoveForTarget,
    leveragedMoveForTarget,
    histogram: makeHist(peakMultiples),
    expiryHistogram: makeHist(multiples),
  };
}

// Helper: theoretical BS price of option at any time-to-expiry (if user wants to mark-to-market early).
export function theoreticalCallPrice(S: number, K: number, daysToExpiry: number, r: number, sigma: number): number {
  return bsCall(S, K, Math.max(0, daysToExpiry / 365), r, sigma);
}
