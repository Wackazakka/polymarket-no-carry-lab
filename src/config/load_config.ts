import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { z } from "zod";

const ResolutionWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  max_hours: z.number().positive(),
});

const ConfigSchema = z.object({
  api: z.object({
    clobRestBaseUrl: z.string().url(),
    clobWsBaseUrl: z.string(),
    gammaBaseUrl: z.string().url(),
  }),
  ws: z
    .object({
      market_url: z.string(),
      max_assets_subscribed: z.number().int().positive().optional().default(200),
    })
    .optional()
    .default({ market_url: "wss://ws-subscriptions-clob.polymarket.com/ws/market", max_assets_subscribed: 200 }),
  scanner: z.object({
    pollIntervalMs: z.number().int().positive(),
    maxOrderbookSubscriptions: z.number().int().positive(),
  }),
  selection: z.object({
    min_no_price: z.number().min(0).max(1),
    max_spread: z.number().min(0).max(1),
    min_liquidity_usd: z.number().min(0),
    max_time_to_resolution_hours: z.number().positive(),
    capture_min_no_ask: z.number().min(0).max(1).optional().default(0.45),
    capture_max_no_ask: z.number().min(0).max(1).optional().default(0.6),
  }),
  fees: z.object({
    fee_bps: z.number().min(0),
    p_tail: z.number().min(0).max(1),
    tail_loss_fraction: z.number().min(0).max(1),
    ambiguous_resolution_p_tail_multiplier: z.number().min(1),
    ev_mode: z.enum(["baseline", "capture"]).optional().default("baseline"),
  }),
  simulation: z.object({
    default_order_size_usd: z.number().positive(),
    slippage_bps: z.number().min(0),
    max_fill_depth_levels: z.number().int().positive(),
  }),
  risk: z.object({
    max_total_exposure_usd: z.number().min(0),
    max_exposure_per_market_usd: z.number().min(0),
    max_positions_open: z.number().int().min(0),
    max_daily_drawdown_usd: z.number().min(0),
    kill_switch_enabled: z.boolean(),
    max_exposure_per_category_usd: z.number().min(0),
    max_exposure_per_assumption_usd: z.number().min(0),
    max_exposure_per_resolution_window_usd: z.number().min(0),
    resolution_windows: z.array(ResolutionWindowSchema).min(1),
  }),
  reporting: z.object({
    report_dir: z.string(),
    daily_report_hour_local: z.number().int().min(0).max(23),
    report_interval_minutes: z.number().int().positive(),
    print_top_n: z.number().int().min(0),
  }),
  db: z.object({
    path: z.string(),
  }),
  control_api: z
    .object({
      port: z.number().int().min(1).max(65535),
    })
    .optional()
    .default({ port: 3344 }),
  diagnostic_loose_filters: z.boolean().optional().default(false),
  carry: z
    .object({
      enabled: z.boolean().optional().default(true),
      maxDays: z.number().positive().optional().default(30),
      roiMinPct: z.number().optional().default(6),
      roiMaxPct: z.number().optional().default(7),
      maxSpread: z.number().min(0).max(1).optional().default(0.02),
      minAskLiqUsd: z.number().min(0).optional().default(500),
      sizeUsd: z.number().positive().optional(),
      bankroll_fraction: z.number().min(0).max(1).optional(),
      allowCategories: z.array(z.string()).optional().default([]),
      allowKeywords: z.array(z.string()).optional().default([]),
      allowSyntheticAsk: z.boolean().optional().default(false),
      syntheticTick: z.number().min(0).max(1).optional().default(0.01),
      syntheticMaxAsk: z.number().min(0).max(1).optional().default(0.995),
      allowHttpFallback: z.boolean().optional().default(true),
      /** Max spread/edge ratio: reject when spread > edge_abs * this (edge = 1 - yesAsk). Default 2.0. */
      spreadEdgeMaxRatio: z.number().min(0).optional().default(2.0),
      /** Min absolute edge (1 - yesAsk) to allow; reject when edge <= this. Default 0 = no min. */
      spreadEdgeMinAbs: z.number().min(0).max(1).optional().default(0.0),
    })
    .optional()
    .default({
      enabled: true,
      maxDays: 30,
      roiMinPct: 6,
      roiMaxPct: 7,
      maxSpread: 0.02,
      minAskLiqUsd: 500,
      allowCategories: [],
      allowKeywords: [],
      allowSyntheticAsk: false,
      syntheticTick: 0.01,
      syntheticMaxAsk: 0.995,
      allowHttpFallback: true,
      spreadEdgeMaxRatio: 2.0,
      spreadEdgeMinAbs: 0.0,
    }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ResolutionWindow = z.infer<typeof ResolutionWindowSchema>;

function findConfigPath(): string {
  const cwd = process.cwd();
  const candidates = [
    join(cwd, "config.json"),
    join(cwd, "src", "config", "config.json"),
    join(cwd, "src", "config", "config.example.json"),
    join(__dirname, "config.json"),
    join(__dirname, "config.example.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Config file not found. Copy src/config/config.example.json to config.json (in project root or src/config). Tried: ${candidates.join(", ")}`
  );
}

/** Returns the path to the config file that would be loaded (first existing from project root or src/config). */
export function getConfigPath(): string {
  return findConfigPath();
}

export function loadConfig(): Config {
  const configPath = findConfigPath();
  const raw = readFileSync(configPath, "utf-8");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in config at ${configPath}: ${String(e)}`);
  }
  const result = ConfigSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues;
    const msg = issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    throw new Error(`Config validation failed: ${msg}`);
  }
  return result.data;
}
