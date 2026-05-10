export type LeveragedTicker = {
  symbol: string;
  name: string;
  underlying: string;
  leverage: number;
};

export const LEVERAGED_TICKERS: LeveragedTicker[] = [
  { symbol: "SOXL", name: "Direxion Daily Semiconductor Bull 3x", underlying: "Semiconductors (ICE Semiconductor Index)", leverage: 3 },
  { symbol: "TQQQ", name: "ProShares UltraPro QQQ", underlying: "Nasdaq-100", leverage: 3 },
  { symbol: "UPRO", name: "ProShares UltraPro S&P 500", underlying: "S&P 500", leverage: 3 },
  { symbol: "SPXL", name: "Direxion Daily S&P 500 Bull 3x", underlying: "S&P 500", leverage: 3 },
  { symbol: "TNA",  name: "Direxion Daily Small Cap Bull 3x", underlying: "Russell 2000", leverage: 3 },
  { symbol: "FNGU", name: "MicroSectors FANG+ 3x Leveraged ETN", underlying: "NYSE FANG+", leverage: 3 },
  { symbol: "LABU", name: "Direxion Daily S&P Biotech Bull 3x", underlying: "S&P Biotech", leverage: 3 },
  { symbol: "NUGT", name: "Direxion Daily Gold Miners Bull 2x", underlying: "Gold Miners", leverage: 2 },
  { symbol: "UDOW", name: "ProShares UltraPro Dow30", underlying: "Dow Jones", leverage: 3 },
  { symbol: "TECL", name: "Direxion Daily Technology Bull 3x", underlying: "Technology Select Sector", leverage: 3 },
  { symbol: "CURE", name: "Direxion Daily Healthcare Bull 3x", underlying: "Healthcare Select Sector", leverage: 3 },
  { symbol: "DPST", name: "Direxion Daily Regional Banks Bull 3x", underlying: "S&P Regional Banks", leverage: 3 },
  { symbol: "RETL", name: "Direxion Daily Retail Bull 3x", underlying: "S&P Retail", leverage: 3 },
  { symbol: "DFEN", name: "Direxion Daily Aerospace & Defense Bull 3x", underlying: "Aerospace & Defense", leverage: 3 },
  { symbol: "WEBL", name: "Direxion Daily Dow Jones Internet Bull 3x", underlying: "Internet", leverage: 3 },
  { symbol: "BNKU", name: "MicroSectors U.S. Big Banks 3x", underlying: "Big Banks", leverage: 3 },
];
