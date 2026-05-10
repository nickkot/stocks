import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const revalidate = 60;
export const dynamic = "force-dynamic";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

type YahooOption = {
  contractSymbol: string;
  strike: number;
  lastPrice: number;
  bid: number;
  ask: number;
  volume?: number;
  openInterest?: number;
  impliedVolatility: number;
  inTheMoney: boolean;
  expiration: number;
};

type YahooResponse = {
  optionChain: {
    result?: Array<{
      underlyingSymbol: string;
      expirationDates: number[];
      strikes: number[];
      quote: { regularMarketPrice: number; shortName?: string };
      options: Array<{ expirationDate: number; calls: YahooOption[]; puts: YahooOption[] }>;
    }>;
    error: null | { code: string; description: string };
  };
};

// In-memory cache of Yahoo session for the lifetime of the lambda instance.
let session: { cookie: string; crumb: string; createdAt: number } | null = null;

async function getYahooSession(force = false): Promise<{ cookie: string; crumb: string }> {
  if (!force && session && Date.now() - session.createdAt < 30 * 60 * 1000) return session;

  // Step 1: visit a Yahoo property to receive A1/A3 consent cookies.
  const seedRes = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": UA },
    redirect: "manual",
  });
  const rawCookie = seedRes.headers.get("set-cookie") || "";
  const cookie = rawCookie
    .split(/,(?=[^ ]+=)/g)
    .map(c => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  // Step 2: exchange those cookies for a crumb token.
  const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: cookie, Accept: "text/plain" },
  });
  const crumb = (await crumbRes.text()).trim();

  if (!crumb || crumb.length > 128) {
    throw new Error(`crumb fetch failed (status ${crumbRes.status})`);
  }
  session = { cookie, crumb, createdAt: Date.now() };
  return session;
}

async function fetchOptions(host: "query1" | "query2", symbol: string, date?: string, withAuth = true) {
  const sess = withAuth ? await getYahooSession() : null;
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
  if (!res.ok) {
    const snippet = text.slice(0, 200);
    throw new Error(`${host} ${res.status}: ${snippet}`);
  }
  return JSON.parse(text) as YahooResponse;
}

async function fetchWithFallback(symbol: string, date?: string): Promise<{ json: YahooResponse; via: string }> {
  const attempts: Array<{ host: "query1" | "query2"; auth: boolean }> = [
    { host: "query2", auth: false },
    { host: "query1", auth: false },
    { host: "query2", auth: true },
    { host: "query1", auth: true },
  ];
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      const json = await fetchOptions(a.host, symbol, date, a.auth);
      if (json.optionChain?.result?.length) {
        return { json, via: `${a.host}${a.auth ? "+auth" : ""}` };
      }
      errors.push(`${a.host}${a.auth ? "+auth" : ""}: empty result`);
    } catch (e: any) {
      errors.push(`${a.host}${a.auth ? "+auth" : ""}: ${e.message}`);
      // If the auth dance failed, force-refresh on next attempt.
      if (a.auth) session = null;
    }
  }
  throw new Error(errors.join(" | "));
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") || "SOXL").toUpperCase();
  const date = searchParams.get("date") || undefined;
  const debug = searchParams.get("debug") === "1";

  try {
    const { json, via } = await fetchWithFallback(symbol, date);
    const result = json.optionChain.result?.[0];
    if (!result) return NextResponse.json({ error: "No data from Yahoo", via }, { status: 502 });

    const spot = result.quote.regularMarketPrice;
    const expirations = result.expirationDates;
    const chain = result.options?.[0];

    const calls = (chain?.calls ?? []).map(c => ({
      contractSymbol: c.contractSymbol,
      strike: c.strike,
      bid: c.bid,
      ask: c.ask,
      last: c.lastPrice,
      mid: c.bid && c.ask ? (c.bid + c.ask) / 2 : c.lastPrice,
      volume: c.volume ?? 0,
      openInterest: c.openInterest ?? 0,
      impliedVolatility: c.impliedVolatility,
      inTheMoney: c.inTheMoney,
      pctOTM: spot > 0 ? (c.strike - spot) / spot : 0,
      expiration: c.expiration,
    }));

    return NextResponse.json({
      symbol,
      shortName: result.quote.shortName ?? symbol,
      spot,
      expirations,
      selectedExpiration: chain?.expirationDate ?? expirations?.[0],
      calls,
      ...(debug ? { via } : {}),
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "fetch failed", hint: "Yahoo may be blocking Vercel egress. Try /api/options?symbol=SOXL&debug=1 to see which transport failed." },
      { status: 502 }
    );
  }
}
