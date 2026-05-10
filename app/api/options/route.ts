import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
// Cache responses on the Vercel edge for 10 min, serve stale up to 1h while revalidating.
export const revalidate = 600;

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

// ---------- CBOE (free, public, ~15 min delayed, no signup) ----------
// Endpoint: https://cdn.cboe.com/api/global/delayed_quotes/options/<SYMBOL>.json
// Some symbols live under /api/global/delayed_quotes/options/_<SYMBOL>.json (indices etc.)

function parseOcc(occ: string): { root: string; expiration: number; type: "C" | "P"; strike: number } | null {
  if (occ.length < 16) return null;
  const root = occ.slice(0, occ.length - 15);
  const yy = parseInt(occ.slice(-15, -13));
  const mm = parseInt(occ.slice(-13, -11));
  const dd = parseInt(occ.slice(-11, -9));
  const type = occ.slice(-9, -8) as "C" | "P";
  const strikeRaw = parseInt(occ.slice(-8));
  if (![2025, 2026, 2027, 2028, 2029, 2030].includes(2000 + yy) && yy < 25) {
    // not strictly necessary, just skip clearly broken symbols
  }
  const epoch = Math.floor(Date.UTC(2000 + yy, mm - 1, dd, 20, 0, 0) / 1000);
  return { root, expiration: epoch, type, strike: strikeRaw / 1000 };
}

async function fetchCboe(symbol: string, dateEpoch?: string): Promise<OutChain> {
  const tryPaths = [
    `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(symbol)}.json`,
    `https://cdn.cboe.com/api/global/delayed_quotes/options/_${encodeURIComponent(symbol)}.json`,
  ];
  let json: any = null;
  let lastErr = "";
  for (const url of tryPaths) {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (res.ok) { json = await res.json(); break; }
    lastErr = `cboe ${res.status} ${url}`;
  }
  if (!json) throw new Error(lastErr || "cboe: no data");

  const d = json.data ?? json;
  const spot = d.current_price ?? d.close ?? d.last_trade_price ?? d.bid ?? 0;
  const shortName = d.security_name ?? d.symbol ?? symbol;
  const options: any[] = d.options ?? [];

  // Group calls by expiration epoch
  const byExp = new Map<number, OutOption[]>();
  for (const o of options) {
    const occ: string = o.option ?? o.symbol;
    const parsed = parseOcc(occ);
    if (!parsed || parsed.type !== "C") continue;
    const bid = Number(o.bid ?? 0);
    const ask = Number(o.ask ?? 0);
    const last = Number(o.last_trade_price ?? o.last ?? 0);
    const mid = bid && ask ? (bid + ask) / 2 : last;
    const row: OutOption = {
      contractSymbol: occ,
      strike: parsed.strike,
      bid, ask, last, mid,
      volume: Number(o.volume ?? 0),
      openInterest: Number(o.open_interest ?? 0),
      impliedVolatility: Number(o.iv ?? 0),
      inTheMoney: spot > parsed.strike,
      pctOTM: spot > 0 ? (parsed.strike - spot) / spot : 0,
      expiration: parsed.expiration,
    };
    if (!byExp.has(parsed.expiration)) byExp.set(parsed.expiration, []);
    byExp.get(parsed.expiration)!.push(row);
  }

  const expirations = [...byExp.keys()].sort((a, b) => a - b);
  if (!expirations.length) throw new Error("cboe: no call options parsed");
  const chosen = dateEpoch ? Number(dateEpoch) : expirations[0];
  const calls = (byExp.get(chosen) ?? byExp.get(expirations[0])!).sort((a, b) => a.strike - b.strike);

  return {
    symbol, shortName, spot, expirations,
    selectedExpiration: chosen,
    calls,
    via: "cboe",
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
  const force = searchParams.get("force") === "1";

  const result = await getCachedChain(symbol, date, force);

  if ("error" in result) {
    return NextResponse.json(result, { status: 502 });
  }
  const body = debug ? result : { ...result, via: undefined };
  return NextResponse.json(body, {
    headers: {
      // Browser: short. CDN: long. Stale-while-revalidate so the user never waits on Yahoo if we have any cached copy.
      "Cache-Control": "public, max-age=30, s-maxage=600, stale-while-revalidate=86400",
    },
  });
}

// ---------- Cache + single-flight ----------
type CacheEntry = { at: number; data: OutChain };
const CACHE = new Map<string, CacheEntry>();
const INFLIGHT = new Map<string, Promise<OutChain>>();
const TTL_MS = 10 * 60 * 1000;       // serve fresh for 10 min
const STALE_MS = 24 * 60 * 60 * 1000; // serve stale for up to 24h on failure

async function getCachedChain(
  symbol: string,
  date: string | undefined,
  force: boolean
): Promise<OutChain | { error: string; hint: string; providers: { tradier: boolean; yahoo: boolean }; stale?: OutChain }> {
  const key = `${symbol}|${date ?? "first"}`;
  const cached = CACHE.get(key);
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.data;

  if (INFLIGHT.has(key)) {
    try { return await INFLIGHT.get(key)!; } catch { /* fall through */ }
  }

  const fetchPromise = (async (): Promise<OutChain> => {
    const tradierAvailable = !!process.env.TRADIER_TOKEN;
    const errors: string[] = [];
    if (tradierAvailable) {
      try { return await fetchTradier(symbol, date); }
      catch (e: any) { errors.push(`tradier: ${e.message}`); }
    }
    try { return await fetchCboe(symbol, date); }
    catch (e: any) { errors.push(e.message); }
    try { return await fetchYahoo(symbol, date); }
    catch (e: any) { errors.push(e.message); throw new Error(errors.join(" || ")); }
  })();

  INFLIGHT.set(key, fetchPromise);
  try {
    const data = await fetchPromise;
    CACHE.set(key, { at: Date.now(), data });
    return data;
  } catch (e: any) {
    // Serve stale data if we have any (even older than TTL) when upstream is failing.
    if (cached && Date.now() - cached.at < STALE_MS) return cached.data;
    return {
      error: e?.message ?? "fetch failed",
      hint: process.env.TRADIER_TOKEN
        ? "Tradier failed and Yahoo is rate-limiting Vercel. Check TRADIER_TOKEN/TRADIER_ENV env vars."
        : "Yahoo Finance returns 429 from Vercel egress. Set TRADIER_TOKEN env var (free at https://developer.tradier.com) and redeploy, or use Manual mode in the UI.",
      providers: { tradier: !!process.env.TRADIER_TOKEN, yahoo: true },
    };
  } finally {
    INFLIGHT.delete(key);
  }
}
