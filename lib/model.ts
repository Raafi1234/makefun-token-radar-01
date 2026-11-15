// The Launch Radar model: one sealed snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug on the snapshot's watchlist (the floor, never a ceiling) and adds the
// strongest pre-token protocols below the floor that pass the same screen the watchlist itself uses:
// no token recorded, and not a wrapped, staked or bridged product of a protocol whose token trades.
//
// The value model is calibrated on the snapshot itself, not on a hand-picked multiple:
//
//   1. Comparables. Every protocol whose token already trades gives one observation of what the
//      market pays per dollar of TVL: ratio = mcap_usd / tvl_usd. Grouped by category, the median
//      ratio is that category's base multiple, shrunk toward the global median by the count of
//      comparables (shrinkage weight SHRINK_K), then clamped to [MULT_FLOOR, MULT_CAP].
//   2. Base value. base = tvl_usd x the protocol's category multiple.
//   3. Growth. change_7d, clamped to [-40, +80] percent, moves the base by GROWTH_WEIGHT of it:
//      growthF = 1 + clamped / 100 x GROWTH_WEIGHT. A hot week helps; it never doubles a board.
//   4. Maturity. A protocol that has run longer with no token recorded has more record to launch
//      on: maturityF rises from MATURITY_BASE to MATURITY_BASE + MATURITY_SPAN over three years
//      since listed_at. Unknown listing dates take the neutral UNKNOWN_AGE_F.
//   5. Breadth. Each extra chain beyond the first adds BREADTH_STEP, capped: breadthF <= 1.08.
//
//   implied_value_usd = round(base x growthF x maturityF x breadthF), at least 1.
//
// No protocol name is ever special-cased: the same functions score every row, and every factor of
// every row is written to board.json and shown in the dashboard's detail view, so a reader can
// re-derive each implied value from the snapshot's own figures.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated in the dashboard so the claim can be checked. */
export const MODEL = {
  version: 'launch-radar-2',
  shrink_k: 6,
  mult_floor: 0.02,
  mult_cap: 3,
  growth_weight: 0.35,
  growth_clamp_lo: -40,
  growth_clamp_hi: 80,
  maturity_base: 0.75,
  maturity_span: 0.35,
  maturity_days: 1095,
  unknown_age_f: 0.9,
  breadth_step: 0.01,
  breadth_cap: 1.08,
  early_rows: 240,
  live_rows: 30,
} as const;

/** Categories whose products are claims on another protocol's asset, not launches of their own. */
const WRAPPED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whole words that mark a wrapped or staked product in a protocol's name. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Exchange names a product may begin with; such a product is the exchange's, not a launch. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A whole day count from listed_at to as_of, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all in the snapshot. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The watchlist's own screen, applied below the floor: pre-token and not a wrapped/staked/bridged product. */
export function passesScreen(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name) || WRAPPED_WORD.test(p.name) || EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** One category's calibration: how many live comparables, their median ratio, the multiple used. */
export interface CategoryComp {
  category: string;
  comps: number;
  median_ratio: number;
  multiple: number;
  examples: { name: string; symbol: string | null; ratio: number }[];
}

/**
 * Calibrate the base multiples on the snapshot's own live-token protocols: for each category, the
 * median market-cap-per-TVL ratio, shrunk toward the global median by the comparable count.
 */
export function calibrate(protocols: SnapshotProtocol[]): { byCategory: Map<string, CategoryComp>; global: CategoryComp } {
  const live = protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const ratios = live.map((p) => p.mcap_usd! / p.tvl_usd);
  const globalMedian = ratios.length > 0 ? median(ratios) : 0.25;

  const groups = new Map<string, SnapshotProtocol[]>();
  for (const p of live) {
    const key = p.category ?? 'Uncategorized';
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [p]);
    else list.push(p);
  }

  const build = (category: string, members: SnapshotProtocol[]): CategoryComp => {
    const rs = members.map((p) => p.mcap_usd! / p.tvl_usd);
    const med = rs.length > 0 ? median(rs) : globalMedian;
    const shrunk = (rs.length * med + MODEL.shrink_k * globalMedian) / (rs.length + MODEL.shrink_k);
    const multiple = Math.min(MODEL.mult_cap, Math.max(MODEL.mult_floor, shrunk));
    const examples = [...members]
      .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0))
      .slice(0, 3)
      .map((p) => ({ name: p.name, symbol: p.symbol, ratio: round4(p.mcap_usd! / p.tvl_usd) }));
    return { category, comps: rs.length, median_ratio: round4(med), multiple: round4(multiple), examples };
  };

  const byCategory = new Map<string, CategoryComp>();
  for (const [category, members] of groups) byCategory.set(category, build(category, members));
  const global = build('All categories', live);
  return { byCategory, global };
}

/** The factors of one protocol's implied value, each one shown to the reader. */
export interface ValueFactors {
  multiple: number;
  comps: number;
  growth_pct: number;
  growth_f: number;
  maturity_f: number;
  breadth_f: number;
  age_days: number | null;
  implied: number;
}

/** Score one pre-token protocol under the calibrated multiples. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  cal: { byCategory: Map<string, CategoryComp>; global: CategoryComp },
): ValueFactors {
  const comp = cal.byCategory.get(p.category ?? 'Uncategorized') ?? cal.global;
  const multiple = comp.multiple;
  const rawGrowth = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  const growthPct = Math.min(MODEL.growth_clamp_hi, Math.max(MODEL.growth_clamp_lo, rawGrowth));
  const growthF = 1 + (growthPct / 100) * MODEL.growth_weight;
  const age = ageDays(asOf, p.listed_at);
  const maturityF =
    age === null
      ? MODEL.unknown_age_f
      : MODEL.maturity_base + (Math.min(age, MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_span;
  const breadthF = Math.min(MODEL.breadth_cap, 1 + Math.max(0, p.chains.length - 1) * MODEL.breadth_step);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthF * maturityF * breadthF));
  return {
    multiple,
    comps: comp.comps,
    growth_pct: growthPct,
    growth_f: round4(growthF),
    maturity_f: round4(maturityF),
    breadth_f: round4(breadthF),
    age_days: age,
    implied,
  };
}

/** Rough per-action gas on a chain, in dollars, from the chain's fee tier. */
function gasFor(chain: string): { label: string; usd: number } {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return { label: 'Ethereum mainnet gas', usd: 8 };
  if (c === 'solana') return { label: 'Solana fees', usd: 0.05 };
  if (c === 'bitcoin') return { label: 'Bitcoin fees', usd: 2 };
  if (c === 'tron') return { label: 'Tron fees', usd: 1 };
  if (['base', 'arbitrum', 'optimism', 'bsc', 'binance', 'polygon', 'avalanche', 'ink', 'monad', 'flare', 'sui', 'stellar', 'algorand', 'plasma'].includes(c))
    return { label: `${chain} fees`, usd: 0.4 };
  return { label: `${chain} fees`, usd: 1 };
}

/** How much capital one farm position carries, tiered by the protocol's own TVL. */
function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 500;
  if (tvl >= 250_000_000) return 250;
  if (tvl >= 50_000_000) return 150;
  return 100;
}

/** How long a position must be held to span more than one points snapshot, from the protocol's age. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** The category's core farming action: what the farmer actually does inside the protocol. */
function coreAction(category: string | null, name: string, chain: string, capital: number): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp'))
    return `Supply $${capital} of USDC as collateral in ${name} on ${chain}, then borrow about 40% against it and re-supply the borrow, so both sides of the market record your wallet`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('collateral'))
    return `Deposit $${capital} of USDC into a ${name} vault on ${chain} and hold the vault shares untouched; curated vaults score wallets that stay, not wallets that churn`;
  if (c.includes('dex') || c.includes('liquidity'))
    return `Add $${capital} of liquidity to ${name}'s busiest pool on ${chain} (the stable or blue-chip pair), in range, and leave the position open`;
  if (c.includes('derivative') || c.includes('perpetual'))
    return `Deposit $${capital} of USDC margin on ${name} and trade one small hedged pair (long and short of equal size) so volume and open interest both register`;
  if (c.includes('basis'))
    return `Open the basis position ${name} is built for with $${capital}: fund the account, take the hedged leg it offers, and keep both legs on`;
  if (c.includes('rwa'))
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it in the farming wallet; RWA issuers reward holders of record at snapshot dates`;
  if (c.includes('restak') || c.includes('staking'))
    return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token in the farming wallet`;
  if (c.includes('yield'))
    return `Deposit $${capital} of USDC into ${name}'s main yield vault on ${chain} and hold the shares through at least one full reward epoch`;
  if (c.includes('chain') || c.includes('payments'))
    return `Bridge $${capital} of USDC to ${chain} and use ${name}'s own apps weekly: one transfer, one swap or one payment, so the wallet reads as a real user of the chain`;
  if (c.includes('insurance'))
    return `Buy $${capital} of cover from ${name} on ${chain} for the longest term offered and keep the policy active for the whole hold`;
  if (c.includes('prediction'))
    return `Fund $${capital} on ${name} and take one position in its most liquid market, then settle it rather than letting it lapse`;
  if (c.includes('stablecoin') || c.includes('algo-stables') || c.includes('reserve'))
    return `Mint $${capital} of the stable asset through ${name} on ${chain} and hold half of it while the other half works in its deepest pool`;
  if (c.includes('launchpad'))
    return `Deposit $${capital} on ${name} and take part in one launch it runs, holding the allocation instead of flipping it on day one`;
  if (c.includes('option'))
    return `Buy one small option position on ${name} with about $${Math.max(25, Math.round(capital / 4))} of premium and let it settle`;
  if (c.includes('index'))
    return `Buy $${capital} of ${name}'s main index basket on ${chain} and hold it; index protocols count holders at rebalances`;
  if (c.includes('privacy'))
    return `Deposit $${capital} through ${name}'s private pool on ${chain} and make one shielded transfer to your own second wallet`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} through its main product and keep the position open for the whole hold`;
}

/** The second, diversifying action of the plan, again by category. */
function secondAction(category: string | null, name: string, chain: string): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp')) return `Open a second, smaller market on ${name} (a different collateral or chain it lists) so the wallet is active in more than one of its markets`;
  if (c.includes('dex') || c.includes('liquidity')) return `Route your weekly swaps through ${name} itself instead of another exchange, so its router records the wallet's volume`;
  if (c.includes('curator') || c.includes('allocator')) return `Split a second deposit into a different ${name} vault with a different curator strategy, so both vaults' holder lists carry the wallet`;
  if (c.includes('rwa')) return `Hold a second ${name} asset or a second maturity if it offers one, so the wallet appears in more than one holder snapshot`;
  return `Repeat the core action once on a second chain ${name} lists, if it lists one, so the wallet is not single-chain in its records`;
}

/**
 * A protocol's farm plan: six concrete steps with a cost and a time each, derived from the
 * protocol's own record (category, first chain, TVL, age) — never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const gas = gasFor(chain);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const weeks = Math.max(4, Math.round(hold / 7));
  const gasRound = (n: number): string => (n < 1 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);
  const steps = [
    `Set up one fresh wallet for ${p.name} alone and fund it with ${gasRound(capital + gas.usd * 6)} on ${chain}; keep the seed phrase offline and never farm from your main wallet. Cost: about ${gasRound(gas.usd)} of ${gas.label} for the funding move. Time: 10 minutes.`,
    `${coreAction(p.category, p.name, chain, capital)}. Cost: $${capital} of capital plus about ${gasRound(gas.usd * 2)} of ${gas.label}. Time: 20 minutes to set up.`,
    `${secondAction(p.category, p.name, chain)}. Cost: about ${gasRound(gas.usd * 2)} of gas. Time: 15 minutes.`,
    `Make one qualifying action a week for ${weeks} weeks (a deposit, a claim, a vote or a small trade inside ${p.name}); steady weekly wallets are what points programs snapshot. Cost: about ${gasRound(gas.usd)} of gas a week. Time: 10 minutes a week.`,
    `Hold every position for at least ${hold} days without withdrawing; ${p.name} has run ${age === null ? 'an unrecorded number of' : age} days with no token recorded, and short holds are the first thing sybil screens cut. Cost: the $${capital} stays locked in the position. Time: ${hold} days.`,
    `Each Sunday, check ${p.name}'s own points or rewards page from the link on its official site and log the balance; claim only from that link and never pay a fee to claim. Cost: nothing to check. Time: 5 minutes a week.`,
    `When a token is announced or the ${hold} days end, withdraw in one transaction during a quiet fee window and keep the farm log (wallet, dates, hashes) with the position's records. Cost: about ${gasRound(gas.usd)} of gas. Time: 15 minutes.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

/** One row of board.json: the ranked board's row, with every model factor stated. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    category_comps: number;
    growth_pct: number;
    growth_f: number;
    maturity_f: number;
    breadth_f: number;
  };
  farm_steps: string[];
}

/** A live-token protocol, shown as a comparable: the market's own value, never a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  ratio: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders: the board, the live comparables, and the calibration. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: Record<string, number | string>;
  scanned: number;
  pre_token: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_multiple: number;
  categories: CategoryComp[];
  rows: (BoardRow & { farm_steps: string[] })[];
  live: LiveRow[];
}

/** The ranked board: every watchlist slug, plus the strongest screened early protocols below the floor. */
export function buildBoard(snapshot: Snapshot): { board: BoardRow[]; cal: ReturnType<typeof calibrate> } {
  const cal = calibrate(snapshot.protocols);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlist = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && passesScreen(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, MODEL.early_rows);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, f: impliedValue(p, snapshot.as_of, cal) }));
  scored.sort((a, b) => b.f.implied - a.f.implied || (a.p.slug < b.p.slug ? -1 : 1));
  const board = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.f.age_days,
    on_watchlist: watchlist.has(s.p.slug),
    implied_value_usd: s.f.implied,
    model: {
      category_multiple: s.f.multiple,
      category_comps: s.f.comps,
      growth_pct: s.f.growth_pct,
      growth_f: s.f.growth_f,
      maturity_f: s.f.maturity_f,
      breadth_f: s.f.breadth_f,
    },
    farm_steps: farmSteps(s.p, s.f.age_days),
  }));
  return { board, cal };
}

/** The live-token comparables, by market cap, for the dashboard's comparables view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, MODEL.live_rows)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      ratio: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard needs, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { board, cal } = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const categories = [...cal.byCategory.values()].sort((a, b) => b.comps - a.comps || (a.category < b.category ? -1 : 1));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL.version,
    model: { ...MODEL },
    scanned: snapshot.protocols.length,
    pre_token: snapshot.protocols.filter(isPreToken).length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.on_watchlist).length,
    live_size: live.length,
    global_multiple: cal.global.multiple,
    categories,
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, shared values, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'a slug appears twice on the board';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++)
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${i + 1} outranks rank ${i} on implied value`;
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd)
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000)
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
