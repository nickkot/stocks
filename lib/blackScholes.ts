// Standard normal CDF via Abramowitz & Stegun approximation.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function bsCall(S: number, K: number, T: number, r: number, sigma: number, q = 0): number {
  if (T <= 0) return Math.max(0, S - K);
  if (sigma <= 0) return Math.max(0, S * Math.exp(-q * T) - K * Math.exp(-r * T));
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * Math.exp(-q * T) * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
}

// Implied vol via bisection on a call price.
export function impliedVolCall(price: number, S: number, K: number, T: number, r: number, q = 0): number {
  if (price <= 0 || T <= 0) return 0;
  let lo = 1e-4;
  let hi = 5;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const p = bsCall(S, K, T, r, mid, q);
    if (p > price) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-5) break;
  }
  return (lo + hi) / 2;
}

// Probability that S_T > K under risk-neutral GBM (real-world if you supply mu instead of r).
export function probSTAboveK(S: number, K: number, T: number, mu: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return S > K ? 1 : 0;
  const d2 = (Math.log(S / K) + (mu - 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return normCdf(d2);
}

// First-passage probability that GBM(S, μ, σ) ever touches an upper barrier B during [0, T].
// Reflection-principle closed form. Returns 1 if S already ≥ B.
export function probTouchUpperBarrier(S: number, B: number, T: number, mu: number, sigma: number): number {
  if (S >= B) return 1;
  if (T <= 0 || sigma <= 0) return 0;
  const nu = mu - 0.5 * sigma * sigma;
  const b = Math.log(B / S);
  const sqT = sigma * Math.sqrt(T);
  const term1 = normCdf((nu * T - b) / sqT);
  const term2 = Math.exp((2 * nu * b) / (sigma * sigma)) * normCdf((-nu * T - b) / sqT);
  return Math.min(1, Math.max(0, term1 + term2));
}

// 2D IV surface on a regular grid in (T_years, log-moneyness ln(K/S)).
// Built from a chain of (T, lnM, IV) samples via inverse-distance weighting (k=8 neighbors).
// Lookup is bilinear.
export type IvSurface = {
  Tgrid: number[];      // ascending years to expiry
  Mgrid: number[];      // ascending log-moneyness
  iv: number[][];       // iv[i][j] = IV at Tgrid[i], Mgrid[j]
};

export function buildIvSurface(samples: { T: number; lnM: number; iv: number }[]): IvSurface | null {
  const clean = samples.filter(s => Number.isFinite(s.T) && Number.isFinite(s.lnM) && s.iv > 0.01 && s.iv < 5);
  if (clean.length < 6) return null;

  const Tmin = Math.min(...clean.map(s => s.T));
  const Tmax = Math.max(...clean.map(s => s.T));
  const Mmin = Math.min(...clean.map(s => s.lnM));
  const Mmax = Math.max(...clean.map(s => s.lnM));
  const NT = 24, NM = 24;
  const Tgrid = Array.from({ length: NT }, (_, i) => Tmin + (Tmax - Tmin) * i / (NT - 1));
  const Mgrid = Array.from({ length: NM }, (_, j) => Mmin + (Mmax - Mmin) * j / (NM - 1));
  const Tscale = Math.max(0.05, Tmax - Tmin);
  const Mscale = Math.max(0.05, Mmax - Mmin);
  const iv: number[][] = Array.from({ length: NT }, () => new Array(NM).fill(0));

  for (let i = 0; i < NT; i++) {
    for (let j = 0; j < NM; j++) {
      // k=8 nearest IDW
      const ranked = clean
        .map(s => {
          const dT = (s.T - Tgrid[i]) / Tscale;
          const dM = (s.lnM - Mgrid[j]) / Mscale;
          return { iv: s.iv, d2: dT * dT + dM * dM };
        })
        .sort((a, b) => a.d2 - b.d2)
        .slice(0, 8);
      let num = 0, den = 0;
      for (const r of ranked) {
        const w = 1 / (r.d2 + 1e-6);
        num += w * r.iv;
        den += w;
      }
      iv[i][j] = den > 0 ? num / den : 0.5;
    }
  }
  return { Tgrid, Mgrid, iv };
}

export function lookupIv(surface: IvSurface, T: number, lnM: number): number {
  const { Tgrid, Mgrid, iv } = surface;
  const NT = Tgrid.length, NM = Mgrid.length;
  // Clamp to grid range.
  const Tc = Math.max(Tgrid[0], Math.min(Tgrid[NT - 1], T));
  const Mc = Math.max(Mgrid[0], Math.min(Mgrid[NM - 1], lnM));
  // Find indices.
  let i0 = 0;
  for (let i = 0; i < NT - 1; i++) if (Tgrid[i] <= Tc && Tc <= Tgrid[i + 1]) { i0 = i; break; }
  let j0 = 0;
  for (let j = 0; j < NM - 1; j++) if (Mgrid[j] <= Mc && Mc <= Mgrid[j + 1]) { j0 = j; break; }
  const tT = (Tc - Tgrid[i0]) / Math.max(1e-9, Tgrid[i0 + 1] - Tgrid[i0]);
  const tM = (Mc - Mgrid[j0]) / Math.max(1e-9, Mgrid[j0 + 1] - Mgrid[j0]);
  const a = iv[i0][j0]     * (1 - tM) + iv[i0][j0 + 1]     * tM;
  const b = iv[i0 + 1][j0] * (1 - tM) + iv[i0 + 1][j0 + 1] * tM;
  return a * (1 - tT) + b * tT;
}

// Inverse of bsCall: find the spot price that makes the call worth `targetPrice` today,
// holding T, sigma, r constant. Bisection on [K*0.01, K*100]. Returns NaN if not bracketed.
export function spotForCallPrice(targetPrice: number, K: number, T: number, r: number, sigma: number, q = 0): number {
  if (targetPrice <= 0) return 0;
  let lo = K * 0.01;
  let hi = K * 100;
  const f = (S: number) => bsCall(S, K, T, r, sigma, q) - targetPrice;
  if (f(lo) > 0) return lo;
  if (f(hi) < 0) return NaN;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) > 0) hi = mid; else lo = mid;
    if (hi - lo < 1e-4) break;
  }
  return 0.5 * (lo + hi);
}
