import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const revalidate = 60;

type YahooOption = {
  contractSymbol: string;
  strike: number;
  lastPrice: number;
  bid: number;
  ask: number;
  change: number;
  percentChange: number;
  volume?: number;
  openInterest?: number;
  impliedVolatility: number;
  inTheMoney: boolean;
  expiration: number;
};

type YahooResponse = {
  optionChain: {
    result: Array<{
      underlyingSymbol: string;
      expirationDates: number[];
      strikes: number[];
      quote: { regularMarketPrice: number; shortName?: string };
      options: Array<{ expirationDate: number; calls: YahooOption[]; puts: YahooOption[] }>;
    }>;
    error: null | { code: string; description: string };
  };
};

async function fetchYahoo(symbol: string, date?: string) {
  const url = new URL(`https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`);
  if (date) url.searchParams.set("date", date);
  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
    next: { revalidate: 60 },
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  return (await res.json()) as YahooResponse;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") || "SOXL").toUpperCase();
  const date = searchParams.get("date") || undefined;

  try {
    const json = await fetchYahoo(symbol, date);
    const result = json.optionChain.result?.[0];
    if (!result) return NextResponse.json({ error: "No data" }, { status: 404 });

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
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "fetch failed" }, { status: 500 });
  }
}
