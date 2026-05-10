import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

type OutOption = {
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

type OutChain = {
  symbol: string;
  shortName: string;
  spot: number;
  expirations: number[];
  selectedExpiration: number;
  calls: OutOption[];
  via: string;
};

// ---------- Tradier (preferred — works from Vercel) ----------
async function tradierBase(): Promise<{ host: string; token: string } | null> {
  const token = process.env.TRADIER_TOKEN;
  if (!token) return null;
  const sandbox = (process.env.TRADIER_ENV ?? "sandbox").toLowerCase() !== "production";
  return { host: sandbox ? "https://sandbox.tradier.com" : "https://api.tradier.com", token };
}

async function tradierFetch(path: string, params: Record<string, string>) {
  const cfg = await tradierBase();
  if (!cfg) throw new Error("TRADIER_TOKEN not set");
  const url = new URL(cfg.host + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Tradier ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function fetchTradier(symbol: string, dateStr?: string): Promise<OutChain> {
  const quoteJson = await tradierFetch("/v1/markets/quotes", { symbols: symbol });
  const q = quoteJson?.quotes?.quote;
  const spot = Array.isArray(q) ? q[0]?.last : q?.last;
  const shortName = (Array.isArray(q) ? q[0]?.description : q?.description) ?? symbol;
  if (!spot) throw new Error("Tradier: no quote");

  const expJson = await tradierFetch("/v1/markets/options/expirations", { symbol, includeAllRoots: "true" });
  const expDates: string[] = expJson?.expirations?.date ?? [];
  if (!expDates.length) throw new Error("Tradier: no expirations");
  const chosen = dateStr || expDates[0];

  const chainJson = await tradierFetch("/v1/markets/options/chains", { symbol, expiration: chosen, greeks: "true" });
  const opts = chainJson?.options?.option ?? [];
  const calls = (Array.isArray(opts) ? opts : [opts])
    .filter((o: any) => o.option_type === "call")
    .map((o: any): OutOption => {
      const bid = o.bid ?? 0;
      const ask = o.ask ?? 0;
      const last = o.last ?? 0;
      const mid = bid && ask ? (bid + ask) / 2 : last;
      const expEpoch = Math.floor(new Date(o.expiration_date + "T20:00:00Z").getTime() / 1000);
      return {
        contractSymbol: o.symbol,
        strike: o.strike,
        bid, ask, last, mid,
        volume: o.volume ?? 0,
        openInterest: o.open_interest ?? 0,
        impliedVolatility: o.greeks?.mid_iv ?? o.greeks?.smv_vol ?? 0,
        inTheMoney: spot > o.strike,
        pctOTM: spot > 0 ? (o.strike - spot) / spot : 0,
        expiration: expEpoch,
      };
    });

  return {
    symbol,
    shortName,
    spot,
    expirations: expDates.map(d => Math.floor(new Date(d + "T20:00:00Z").getTime() / 1000)),
    selectedExpiration: Math.floor(new Date(chosen + "T20:00:00Z").getTime() / 1000),
    calls,
    via: "tradier",
  };
}

// ---------- Yahoo (works locally, blocked on Vercel) ----------
let session: { cookie: string; crumb: string; createdAt: number } | null = null;
async function getYahooSession(force = false) {
  if (!force && session && Date.now() - session.createdAt < 30 * 60 * 1000) return session;
  const seedRes = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
  const rawCookie = seedRes.headers.get("set-cookie") || "";
  const cookie = rawCookie.split(/,(?=[^ ]+=)/g).map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
  const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: cookie, Accept: "text/plain" },
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.length > 128) throw new Error(`crumb fetch failed (${crumbRes.status})`);
  session = { cookie, crumb, createdAt: Date.now() };
  return session;
}

async function fetchYahoo(symbol: string, date?: string): Promise<OutChain> {
  const errors: string[] = [];
  for (const host of ["query2", "query1"] as const) {
    for (const auth of [false, true]) {
      try {
        const sess = auth ? await getYahooSession() : null;
        const url = new URL(`https://${host}.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`);
        if (date) url.searchParams.set("date", date);
        if (sess) url.searchParams.set("crumb", sess.crumb);
        const res = await fetch(url.toString(), {
          headers: {
            "User-Agent": UA,
            Accept: "application/json,text/plain,*/*",
            "Accept-Language": "en-US,en;q=0.9",
            ...(sess ? { Cookie: sess.cookie } : {}),
          },
          cache: "no-store",
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`${host}${auth ? "+auth" : ""} ${res.status}`);
        const json = JSON.parse(text);
        const result = json.optionChain?.result?.[0];
        if (!result) throw new Error(`${host}${auth ? "+auth" : ""} empty`);
        const spot = result.quote.regularMarketPrice;
        const chain = result.options?.[0];
        const calls: OutOption[] = (chain?.calls ?? []).map((c: any) => ({
          contractSymbol: c.contractSymbol,
          strike: c.strike,
          bid: c.bid, ask: c.ask, last: c.lastPrice,
          mid: c.bid && c.ask ? (c.bid + c.ask) / 2 : c.lastPrice,
          volume: c.volume ?? 0,
          openInterest: c.openInterest ?? 0,
          impliedVolatility: c.impliedVolatility,
          inTheMoney: c.inTheMoney,
          pctOTM: spot > 0 ? (c.strike - spot) / spot : 0,
          expiration: c.expiration,
        }));
        return {
          symbol,
          shortName: result.quote.shortName ?? symbol,
          spot,
          expirations: result.expirationDates,
          selectedExpiration: chain?.expirationDate ?? result.expirationDates?.[0],
          calls,
          via: `yahoo-${host}${auth ? "+auth" : ""}`,
        };
      } catch (e: any) {
        errors.push(e.message);
        if (auth) session = null;
      }
    }
  }
  throw new Error("yahoo: " + errors.join(" | "));
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") || "SOXL").toUpperCase();
  const date = searchParams.get("date") || undefined;
  const debug = searchParams.get("debug") === "1";

  const tradierAvailable = !!process.env.TRADIER_TOKEN;
  const errors: string[] = [];

  if (tradierAvailable) {
    try {
      const out = await fetchTradier(symbol, date);
      return NextResponse.json(debug ? out : { ...out, via: undefined });
    } catch (e: any) {
      errors.push(e.message);
    }
  }
  try {
    const out = await fetchYahoo(symbol, date);
    return NextResponse.json(debug ? out : { ...out, via: undefined });
  } catch (e: any) {
    errors.push(e.message);
  }

  return NextResponse.json(
    {
      error: errors.join(" || "),
      hint: tradierAvailable
        ? "Tradier failed and Yahoo is rate-limiting Vercel. Check TRADIER_TOKEN/TRADIER_ENV env vars."
        : "Yahoo Finance blocks Vercel egress (429). Set TRADIER_TOKEN env var (free sandbox key at https://developer.tradier.com) and redeploy, or use Manual mode in the UI.",
      providers: { tradier: tradierAvailable, yahoo: true },
    },
    { status: 502 }
  );
}
