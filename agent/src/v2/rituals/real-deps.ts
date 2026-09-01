// Bull v2 — rituals: REAL adapter wiring for the run-v2-* entry wrappers. This is the ONLY rituals
// file that touches network adapters / the SDK / Discord — orchestrators stay port-driven and the
// tests never import this module. Config is loaded ONCE per process (per ritual run) here.
import { openDb } from "../db.js";
import { loadConfig, type EffectiveConfig } from "../config.js";
import { effectiveMode } from "../../mode.js";
import { alpacaBroker, alpacaReadPort } from "../broker.js";
import { latestPrice, getBars } from "../../alpaca.js";
import { isMarketDayToday } from "../../market-calendar.js";
import { postBill } from "../surfaces/discord.js";
import { readLeiFile, spyAbove200 } from "../book/lei-dial.js";
import { alpacaCorporateActions } from "../book/corporate-actions.js";
import { sdkLlmPort } from "../judgment/llm-port.js";
import { addDays } from "../lots.js";
import { edgarLive as insEdgarLive } from "../sleeves/insider/edgar.js";
import { alpacaMarketPort, alpacaPricePort as insCarPricePort, sectorPortStub } from "../sleeves/insider/market.js";
import { wikipediaUniversePort } from "../sleeves/momentum/wikipedia.js";
import { alpacaPricePort as momAlpacaPrices, alpacaAssetsPort } from "../sleeves/momentum/alpaca-ports.js";
import { makeEdgarFundamentalsPort } from "../sleeves/momentum/edgar.js";
import type { MomPorts } from "../sleeves/momentum/month-end.js";
import { edgarLive as ancEdgarLive } from "../sleeves/anchor/edgar.js";
import { openFigiMapping } from "../sleeves/anchor/mapping.js";
import { alpacaPricePort as ancAlpacaPrices } from "../sleeves/anchor/prices.js";
import type { AnchorPorts } from "../sleeves/anchor/index.js";
import { siblingPoolPort, alpacaCardPort, llmPickPort } from "../sleeves/wildcard/adapters.js";
import type { WildcardPorts } from "../sleeves/wildcard/run.js";
import { etDateKey, etHHMM, etWeekday } from "./time.js";
import type { CoreDeps, DailyBarsFn } from "./support.js";
import type { MorningDeps } from "./morning.js";
import type { EveningDeps } from "./evening.js";
import type { WeeklyDeps } from "./weekly.js";
import type { AnchorFilingDeps } from "./anchor-filing.js";
import type { InsiderPollDeps } from "./insider-poll.js";

function core(): CoreDeps & { eff: EffectiveConfig } {
  return {
    db: openDb(),
    eff: loadConfig(),
    // Double-gated (v1 rail carried forward): MODE=auto alone runs as gated until
    // BILL_ALLOW_AUTO_EXEC=1 is also set in the env.
    mode: effectiveMode(),
    today: etDateKey(),
    post: postBill,
    latestPrice,
  };
}

const dailyBars: DailyBarsFn = async (symbol, lookbackDays) => {
  const end = etDateKey();
  return getBars(symbol, addDays(end, -Math.max(lookbackDays, 5)), end, "1Day", 1000);
};

async function spyAbove200dma(): Promise<boolean | null> {
  const bars = await dailyBars("SPY", 330);
  return spyAbove200(bars.map((b) => b.c));
}

function anchorPorts(): AnchorPorts {
  return { edgar: ancEdgarLive(), mapping: openFigiMapping(), prices: ancAlpacaPrices };
}

export function realMorningDeps(): MorningDeps {
  const c = core();
  return {
    ...c,
    broker: alpacaBroker,
    read: alpacaReadPort,
    marketDay: isMarketDayToday,
    leiReading: () => readLeiFile(),
    spyAbove200dma,
    dailyBars,
    insMarket: alpacaMarketPort(insEdgarLive),
    insSector: sectorPortStub,
    momPrices: momAlpacaPrices,
    wldPorts: {
      pool: siblingPoolPort(c.db),
      card: alpacaCardPort(),
      pick: llmPickPort(sdkLlmPort), // wired 2026-09-01 (CJ's call) — one stateless Sonnet ranking a week
    } satisfies WildcardPorts,
    ancPrices: ancAlpacaPrices,
    weekday: () => etWeekday(),
  };
}

export function realEveningDeps(): EveningDeps {
  const c = core();
  return {
    ...c,
    broker: alpacaBroker,
    read: alpacaReadPort,
    marketDay: isMarketDayToday,
    insEdgar: insEdgarLive,
    insCarPrices: insCarPricePort,
    corpPort: alpacaCorporateActions,
    llm: sdkLlmPort,
    dailyBars,
  };
}

export function realWeeklyDeps(): WeeklyDeps {
  const c = core();
  const momPorts: MomPorts = {
    universe: wikipediaUniversePort,
    assets: alpacaAssetsPort,
    prices: momAlpacaPrices,
    fundamentals: makeEdgarFundamentalsPort(c.db),
  };
  return { ...c, llm: sdkLlmPort, momPorts, ancPorts: anchorPorts() };
}

export function realAnchorFilingDeps(): AnchorFilingDeps {
  return { ...core(), ancPorts: anchorPorts() };
}

export function realInsiderPollDeps(): InsiderPollDeps {
  return { ...core(), insEdgar: insEdgarLive, weekday: () => etWeekday(), hhmm: () => etHHMM() };
}

export function realStatementDeps(): CoreDeps {
  return core();
}
