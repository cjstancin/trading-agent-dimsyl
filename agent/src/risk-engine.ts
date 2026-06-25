// Deterministic RISK ENGINE (Bull v5 — hybrid overhaul, Phase 1). The layer that OWNS sizing + portfolio risk
// and can OVERRIDE the LLM. Pure + testable: NO network, NO orders. The LLM only proposes ideas; this engine
// decides how much (if anything) to buy — sizing by RISK + VOLATILITY, never by subjective conviction — and
// enforces portfolio-level caps. Defaults are sourced from the 2026-06-25 deep-research spec:
//   risk ≤1%/trade (Van Tharp CPR) · Elder 6% portfolio-heat ceiling · inverse-vol / vol-target sizing (AQR) ·
//   fractional-Kelly 0.25–0.5 hard cap · Chandelier ATR(22)×3 stop (StockCharts) · 200-day-MA regime filter.
// See: 01_Knowledge/Projects/AI Manager - AgentSims/2026-06-25 Bill the Bull — hybrid trading-system overhaul.

export interface RiskConfig {
  riskPerTradePct: number;     // fixed-fractional risk budget per trade (% of equity)
  maxPortfolioHeatPct: number; // Elder 6% rule — aggregate OPEN risk ceiling across all positions
  maxNamePct: number;          // per-position exposure cap (% of equity)
  maxSectorPct: number;        // per-sector exposure cap (% of equity)
  targetVolPct: number;        // annualized volatility target (for vol-targeting)
  kellyFraction: number;       // hard fractional-Kelly multiplier (0.25–0.5) — never bet full Kelly
  atrMult: number;             // ATR / Chandelier stop multiplier
  atrPeriod: number;           // Chandelier lookback (and its ATR period)
  maxLeverage: number;         // vol-target leverage cap (1.0 = cash account, no margin)
}

// MODERATE risk profile (CJ, 2026-06-25): 1.5% risk/trade, 10% portfolio-heat ceiling — disciplined but
// meaningfully deployed (~6–8 positions), more aggressive than the textbook 6%/1% but far from reckless.
export const DEFAULT_RISK: RiskConfig = {
  riskPerTradePct: 1.5, maxPortfolioHeatPct: 10, maxNamePct: 20, maxSectorPct: 30,
  targetVolPct: 15, kellyFraction: 0.5, atrMult: 3, atrPeriod: 22, maxLeverage: 1,
};

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

// ───────────────────────── volatility-based sizing ─────────────────────────

/** Inverse-volatility weights: wᵢ = (1/σᵢ) / Σ(1/σ). Lower-vol names get more weight; weights sum to 1. */
export function inverseVolWeights(vols: number[]): number[] {
  const inv = vols.map((v) => (v > 0 ? 1 / v : 0));
  const tot = inv.reduce((a, b) => a + b, 0);
  return tot > 0 ? inv.map((x) => x / tot) : vols.map(() => 0);
}

/** Volatility-target leverage = targetVol / realizedVol, capped. Scales exposure UP in calm markets, DOWN in
 *  volatile ones. 0 if realized vol is unknown. (cfg.maxLeverage caps it; 1.0 for a cash account.) */
export function volTargetLeverage(realizedVolPct: number, cfg: RiskConfig = DEFAULT_RISK): number {
  if (!(realizedVolPct > 0)) return 0;
  return Math.min(cfg.maxLeverage, cfg.targetVolPct / realizedVolPct);
}

/** Fractional-Kelly: clamp the raw full-Kelly fraction to ≥0, then apply the hard 0.25–0.5 multiplier.
 *  Full Kelly is provably ruinous to overbet; practitioners run a fraction. Returns a capital fraction. */
export function fractionalKelly(fullKelly: number, cfg: RiskConfig = DEFAULT_RISK): number {
  return Math.max(0, fullKelly) * cfg.kellyFraction;
}

/** Risk-based share count (Van Tharp CPR): risk budget ($ = riskPct×equity) ÷ per-share stop distance, then
 *  capped by the per-name exposure cap. Fractional shares. The deterministic replacement for conviction sizing. */
export function sizeByRisk(equity: number, price: number, stopPrice: number, cfg: RiskConfig = DEFAULT_RISK): number {
  if (!(equity > 0) || !(price > 0) || !(stopPrice >= 0) || stopPrice >= price) return 0;
  const riskDollars = equity * (cfg.riskPerTradePct / 100);
  const perShareRisk = price - stopPrice;
  const riskShares = riskDollars / perShareRisk;
  const capShares = ((cfg.maxNamePct / 100) * equity) / price;
  return Math.max(0, r4(Math.min(riskShares, capShares)));
}

// ───────────────────────── volatility (ATR) ─────────────────────────

export interface Bar { h: number; l: number; c: number; }

/** Average True Range over `period` from ascending daily bars. TR = max(high−low, |high−prevClose|,
 *  |low−prevClose|); ATR = mean of the last `period` TRs. Returns 0 if there aren't enough bars (caller
 *  falls back to a default % stop). The volatility input for ATR-based stops + vol sizing. */
export function atrFromBars(bars: Bar[], period = 22): number {
  if (!Array.isArray(bars) || bars.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i - 1].c;
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc)));
  }
  const last = trs.slice(-period);
  return last.reduce((a, b) => a + b, 0) / last.length;
}

// ───────────────────────── stops (volatility-based) ─────────────────────────

/** Chandelier long stop = highest-high(N) − ATR(N)×mult. Trails up with the high; replaces a flat % trail. */
export function chandelierStop(highestHigh: number, atr: number, cfg: RiskConfig = DEFAULT_RISK): number {
  return Math.max(0, highestHigh - atr * cfg.atrMult);
}

/** Fresh ATR stop from an entry: entry − ATR×mult. */
export function atrStop(entry: number, atr: number, cfg: RiskConfig = DEFAULT_RISK): number {
  return Math.max(0, entry - atr * cfg.atrMult);
}

// ───────────────────────── portfolio risk gate (the override) ─────────────────────────

export interface OpenPosition {
  symbol: string;
  sector?: string;
  marketValue: number;   // current $ exposure
  riskDollars: number;   // open risk = (current price − its stop) × shares (≥0)
}
export interface ProposedBuy {
  symbol: string;
  sector?: string;
  price: number;
  stopPrice: number;
  shares: number;        // the risk-sized share count from sizeByRisk()
}
export interface GateResult {
  ok: boolean;
  shares: number;        // allowed shares (resized down, or 0 if rejected)
  reasons: string[];     // what caps bound it (audit trail)
}

/** THE OVERRIDE. Given the live book + a proposed (already risk-sized) buy, approve / resize-down / reject it
 *  against the per-name cap, per-sector cap, and the portfolio-heat ceiling — whichever binds tightest. Pure. */
export function riskGate(buy: ProposedBuy, book: { equity: number; positions: OpenPosition[] }, cfg: RiskConfig = DEFAULT_RISK): GateResult {
  const reasons: string[] = [];
  const equity = book.equity;
  if (!(equity > 0) || !(buy.price > 0) || !(buy.shares > 0)) return { ok: false, shares: 0, reasons: ["invalid input"] };
  let shares = buy.shares;

  // 1) per-name exposure cap
  const nameCapShares = ((cfg.maxNamePct / 100) * equity) / buy.price;
  if (shares > nameCapShares) { shares = nameCapShares; reasons.push(`capped to ${cfg.maxNamePct}% per-name`); }

  // 2) per-sector exposure cap (existing sector $ + this buy ≤ cap)
  if (buy.sector) {
    const sectorVal = book.positions.filter((p) => p.sector === buy.sector).reduce((s, p) => s + p.marketValue, 0);
    const roomShares = Math.max(0, (cfg.maxSectorPct / 100) * equity - sectorVal) / buy.price;
    if (shares > roomShares) { shares = roomShares; reasons.push(`capped to ${cfg.maxSectorPct}% ${buy.sector} sector`); }
  }

  // 3) portfolio-heat ceiling (aggregate OPEN risk across all positions ≤ cap)
  const openRisk = book.positions.reduce((s, p) => s + Math.max(0, p.riskDollars || 0), 0);
  const perShareRisk = Math.max(0, buy.price - buy.stopPrice);
  if (perShareRisk > 0) {
    const roomShares = Math.max(0, (cfg.maxPortfolioHeatPct / 100) * equity - openRisk) / perShareRisk;
    if (shares > roomShares) { shares = roomShares; reasons.push(`capped to ${cfg.maxPortfolioHeatPct}% portfolio heat`); }
  }

  shares = Math.max(0, r4(shares));
  if (shares <= 0) return { ok: false, shares: 0, reasons: reasons.length ? reasons : ["no room under risk caps"] };
  return { ok: true, shares, reasons };
}

// ───────────────────────── regime filter ─────────────────────────

/** 200-day-MA regime: risk-ON when price ≥ MA200 (deploy), risk-OFF below (reduce / go to cash). Unknown MA → on. */
export function regimeOn(price: number, ma200: number): boolean {
  return ma200 > 0 ? price >= ma200 : true;
}
