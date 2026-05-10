# Leveraged Options Lab

A Vercel-ready Next.js app for hunting far-out-of-the-money call options on
triple-leveraged ETFs (SOXL, TQQQ, UPRO, SPXL, TNA, FNGU, LABU, …) and running
Monte Carlo simulations to estimate the probability of 100x payoffs.

## What it does

1. **Live option chains** — pulls calls from Yahoo Finance for any of the
   pre-configured leveraged ETFs at any listed expiration.
2. **Far-OTM filter** — slice the chain by `% OTM`, open-interest, etc.
3. **Per-contract metrics** — breakeven, strike to hit Nx target, implied
   move required, and a closed-form probability under your assumed underlying
   drift/vol (with leveraged-ETF volatility decay baked in).
4. **Monte Carlo simulator** — simulates the underlying as GBM, then compounds
   it daily as `L · r_under − (expense + financing·(L−1))/252` to capture
   real volatility decay, then prices the option as intrinsic at expiry.
   Reports P(double), P(10x), P(100x), payoff distribution, percentiles.

## Run locally

```bash
npm install
npm run dev
```

## Deploy to Vercel

```bash
vercel
```

Or just push to GitHub and import the repo at https://vercel.com/new — no env
vars required.

## Notes & disclaimers

* Option data via Yahoo Finance's unofficial endpoint — fine for tinkering,
  not for trading. Add a paid feed (Polygon, Tradier) for production.
* Every probability you see is conditional on the assumptions you typed.
  The point of the simulator is to show how brittle the path-to-100x is.
* Not financial advice.
