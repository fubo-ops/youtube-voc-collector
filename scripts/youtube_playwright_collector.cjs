#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { stdin: input, stdout: output } = require("node:process");
const vocCore = require("./youtube_voc_core.cjs");

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = __dirname;
const DEFAULT_TARGET_VIDEOS = 100;
const DEFAULT_COMMENTS_PER_VIDEO = 20;
const DEFAULT_VIDEOS_PER_QUERY = 15;
const DEFAULT_DETAIL_CONCURRENCY = 1;
const DEFAULT_TARGET_COMMENTS = 100;
const DEFAULT_BROWSER_CHANNEL = "chrome";
const DEFAULT_OUT_DIR = path.resolve(process.cwd(), "outputs/youtube");
const ASIN_RE = /^[A-Z0-9]{10}$/;
const SELLERSPRITE_REVERSE_URL = "https://www.sellersprite.com/v3/keyword-reverse/";

const USAGE = `
Usage:
  node scripts/youtube_playwright_collector.cjs --asin ASIN --target-comments 100
  node scripts/youtube_playwright_collector.cjs --asins "ASIN_A,ASIN_B" --target-comments 100
  node scripts/youtube_playwright_collector.cjs --asin-file asins.txt --target-comments 100
  node scripts/youtube_playwright_collector.cjs preflight --asin ASIN [--fixture preflight.json]

Optional:
  --target-comments 100
  --expanded-keywords "manual keyword,manual keyword 2"
  --target-videos 100
  --comments-per-video 20
  --videos-per-query 15
  --detail-concurrency 1
  --max-comments-per-video 20
  --max-reply-actions 40
  --scroll-delay-min 800
  --scroll-delay-max 1400
  --navigation-delay-min 600
  --navigation-delay-max 1200
  --video-timeout 60000
  --max-failures 5
  --max-discovery-rounds 3
  --min-new-comments-per-round 5
  --duplicate-rate-stop 0.85
  --resume CHECKPOINT.json
  --retry-partial
  --force-reaudit-partial
  --seller-term-limit 30
  --max-queries 12
  --max-queries all
  --headless 1
  --channel chrome
  --channel chromium
  --executable-path "/path/to/chromium"
  --out-dir outputs/youtube
  --profile-dir .youtube-voc-browser-profile
`;

async function buildExcelOutput({ jsonlPath, queryPlanPath, manifestPath, excelPath }) {
  const builder = path.join(SCRIPT_DIR, "build_youtube_excel.mjs");
  const { stdout } = await execFileAsync(process.execPath, [
    builder,
    "--jsonl", jsonlPath,
    "--query-plan", queryPlanPath,
    "--manifest", manifestPath,
    "--output", excelPath,
  ], { env: process.env, windowsHide: true, maxBuffer: 1024 * 1024 * 10 });
  return stdout.trim();
}

function loadPlaywrightChromium() {
  try {
    const playwrightPath = require.resolve("playwright", { paths: [process.cwd(), SCRIPT_DIR] });
    return require(playwrightPath).chromium;
  } catch (error) {
    throw new Error(
      [
        "Playwright package is not installed or cannot be resolved from the current project.",
        "Install it in the directory where you run this collector, then rerun:",
        "  npm install playwright",
        "If Chrome is not installed, also run:",
        "  npx playwright install chromium",
      ].join("\n"),
      { cause: error },
    );
  }
}

async function ensureChromiumExecutable(chromium, overridePath) {
  if (overridePath) {
    await fs.access(overridePath);
    return overridePath;
  }
  const executablePath = chromium.executablePath();
  try {
    await fs.access(executablePath);
    return executablePath;
  } catch (_) {
    throw new Error(
      [
        "Playwright Chromium is not installed on this device.",
        "Install it, then rerun this collector:",
        "  npx playwright install chromium",
      ].join("\n"),
    );
  }
}

function parseArgs(argv) {
  const args = { command: argv[2] && !argv[2].startsWith("--") ? argv[2] : "collect" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "1";
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function promptIfMissing(args) {
  const rl = readline.createInterface({ input, output });
  if (!args.asins && !args.asin && !args["asin-file"]) {
    args.asins = (await rl.question("请输入单个 ASIN 或逗号分隔的 ASIN 组: ")).trim();
  }
  rl.close();
  args.asins = vocCore.parseAsinInputs({ asin: args.asin, asins: args.asins, asinFile: args["asin-file"] });
  if (!args["target-videos"]) args["target-videos"] = String(DEFAULT_TARGET_VIDEOS);
  return args;
}

function splitValues(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => String(item).split(/[\n,]+/)).map((part) => part.trim()).filter(Boolean);
}

function validateAsins(value) {
  const result = [];
  const seen = new Set();
  const rawValues = (Array.isArray(value) ? value : [value]).flatMap((item) => String(item || "").split(/[\n,\s]+/)).filter(Boolean);
  for (const raw of rawValues) {
    const asin = raw.toUpperCase();
    if (!ASIN_RE.test(asin)) throw new Error(`Invalid ASIN: ${raw}`);
    if (!seen.has(asin)) {
      seen.add(asin);
      result.push(asin);
    }
  }
  if (!result.length) throw new Error("At least one ASIN is required.");
  return result;
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = String(value).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

function slugify(value) {
  const slug = String(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  return slug || `youtube_voc_${hashId(value).slice(0, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function hashId(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 16);
}

function videoIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtu.be")) return parsed.pathname.replace("/", "") || null;
    return parsed.searchParams.get("v");
  } catch (_) {
    return null;
  }
}

function canonicalVideoUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function searchUrl(query) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

function cleanPhrase(value, maxWords = 14) {
  return String(value || "").replace(/\s+/g, " ").replace(/[|•]+/g, " ").trim().split(" ").slice(0, maxWords).join(" ");
}

const BROAD_SINGLE_TERMS = new Set([
  "dog", "dogs", "joint", "joints", "pet", "pets", "health", "support", "care",
  "large", "small", "soft", "food", "supplement", "supplements", "chew", "chews",
]);
const PHRASE_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "for", "from", "has",
  "have", "in", "is", "it", "of", "on", "or", "the", "this", "to", "with", "your",
]);

function singularToken(token) {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function keywordKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
    .filter(Boolean).map(singularToken).join(" ");
}

function keywordSimilarity(left, right) {
  const a = new Set(keywordKey(left).split(" ").filter(Boolean));
  const b = new Set(keywordKey(right).split(" ").filter(Boolean));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / Math.max(a.size, b.size);
}

function compressSearchKeyword(value) {
  const normalized = String(value || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[#|•:;,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = normalized.split(" ").filter(Boolean);
  if (words.length <= 8) return normalized;
  return words.filter((word) => !PHRASE_STOP_WORDS.has(word.toLowerCase())).slice(0, 8).join(" ");
}

function productAnchor(value) {
  return String(value || "").replace(/[^a-z0-9]+/gi, " ").trim().split(/\s+/)
    .filter((word) => !PHRASE_STOP_WORDS.has(word.toLowerCase()) && !BROAD_SINGLE_TERMS.has(keywordKey(word)))
    .slice(0, 2).join(" ");
}

function cleanKeywordCandidates(candidates) {
  const cleaned = [];
  for (const candidate of candidates) {
    const raw = cleanPhrase(candidate.raw_keyword, 40);
    if (!raw) continue;
    let query = compressSearchKeyword(raw);
    let key = keywordKey(query);
    if (!key || (key.split(" ").length === 1 && BROAD_SINGLE_TERMS.has(key))) continue;
    if (candidate.anchor && (candidate.source === "amazon" || key.split(" ").length === 1)) {
      const anchor = productAnchor(candidate.anchor);
      const anchorTokens = keywordKey(anchor).split(" ");
      const queryTokens = keywordKey(query).split(" ");
      const productToken = anchorTokens[1] || anchorTokens[0];
      if (anchor && productToken && !queryTokens.includes(productToken)) {
        const remainder = query.split(/\s+/).filter((word) => !anchorTokens.includes(keywordKey(word))).join(" ");
        query = compressSearchKeyword(`${anchor} ${remainder}`);
        key = keywordKey(query);
      }
    }
    const match = cleaned.find((row) => row.key === key || keywordSimilarity(row.query, query) >= 0.8);
    const source = candidate.source || "unknown";
    const asins = unique(candidate.asins || (candidate.asin ? [candidate.asin] : []));
    const rawRecord = { keyword: raw, source, asins };
    if (match) {
      match.asins = unique([...match.asins, ...asins]);
      match.keyword_sources = unique([...match.keyword_sources, source]);
      match.raw_keywords = unique([...match.raw_keywords, raw]);
      match.raw_keyword_records.push(rawRecord);
      continue;
    }
    cleaned.push({
      key,
      query,
      dimension: source,
      asins,
      keyword_sources: [source],
      raw_keywords: [raw],
      raw_keyword_records: [rawRecord],
    });
  }
  return cleaned.map(({ key: _, ...row }) => row);
}

function extractAmazonKeywords(product, limit = 8) {
  const candidates = [cleanPhrase(product?.title), ...(product?.bullets || []).map((value) => cleanPhrase(value, 10))];
  return unique(candidates.filter((value) => value.length >= 3)).slice(0, limit);
}

function selectSellerKeywords(text, excluded = [], limit = 30) {
  const body = String(text || "");
  const markers = ["高频词", "Word Frequency"];
  const starts = markers.map((marker) => body.indexOf(marker)).filter((position) => position >= 0);
  if (!starts.length) return [];
  const start = Math.min(...starts);
  const endMarkers = ["\n对比", "\nAdd All to My List", "\nExport Keywords"];
  const ends = endMarkers.map((marker) => body.indexOf(marker, start)).filter((position) => position > start);
  const section = body.slice(start, ends.length ? Math.min(...ends) : undefined);
  const blocked = new Set(splitValues(excluded).map((value) => value.toLowerCase()));
  const result = [];
  const seen = new Set();
  const pattern = /^\s*([a-z0-9][a-z0-9 /'&+.-]{0,80}?)\s+\(([\d,]+)[^)]*\)/gim;
  for (const match of section.matchAll(pattern)) {
    const keyword = cleanPhrase(match[1], 8).toLowerCase();
    if (!keyword || blocked.has(keyword) || seen.has(keyword)) continue;
    seen.add(keyword);
    result.push(keyword);
    if (result.length >= limit) break;
  }
  return result;
}

function deriveExpansionCandidates(context) {
  const title = context.title || context.amazon_keywords?.[0] || context.asin;
  const anchor = productAnchor(title) || context.asin;
  const text = `${title} ${(context.bullets || []).join(" ")}`.toLowerCase();
  const phrases = [
    ["review", "review"], ["customer reviews", "review"], ["veterinarian review", "review"],
    ["benefits", "effect"], ["ingredients explained", "ingredient"], ["effectiveness", "effect"],
    ["results", "effect"], ["before and after", "effect"], ["how long to work", "effect"],
    ["dosage", "dosage"], ["dosage by weight", "dosage"], ["daily dosage", "dosage"],
    ["how to use", "usage"], ["daily use", "usage"], ["long term use", "usage"],
    ["side effects", "safety"], ["safety", "safety"], ["adverse reactions", "safety"],
    ["worth it", "purchase_intent"], ["price", "purchase_intent"], ["where to buy", "purchase_intent"],
    ["Amazon review", "purchase_intent"], ["pros and cons", "purchase_intent"], ["vs alternatives", "purchase_intent"],
  ];
  if (/\bdogs?\b/.test(text)) phrases.push(
    ["for senior dogs", "use_case"], ["for large breed dogs", "use_case"], ["for small breed dogs", "use_case"],
    ["dog mobility support", "problem"], ["stiff joints in dogs", "problem"], ["arthritis support for dogs", "problem"],
    ["how much to give dogs", "dosage"],
  );
  if (/joint|mobility|hip/.test(text)) phrases.push(
    ["joint health benefits", "effect"], ["hip and joint mobility", "use_case"], ["joint pain support", "problem"],
  );
  for (const ingredient of ["glucosamine", "chondroitin", "msm", "methylsulfonylmethane"]) {
    if (text.includes(ingredient)) phrases.push([`${ingredient} benefits`, "ingredient"], [`${ingredient} review`, "ingredient"]);
  }
  if (/chewable|tablet|chew/.test(text)) phrases.push(["chewable tablets review", "format"], ["how to give chewable tablets", "usage"]);
  return phrases.map(([phrase, dimension]) => ({
    raw_keyword: `${anchor} ${phrase}`,
    source: `derived:${dimension}`,
    asins: [context.asin],
  }));
}

function buildKeywordPlan(args, productContexts = []) {
  const rows = [];
  const allAsins = productContexts.map((row) => row.asin);
  for (const keyword of splitValues(args["expanded-keywords"])) rows.push({ raw_keyword: keyword, source: "manual", asins: allAsins });
  const queues = productContexts.map((context) => {
    const queue = [];
    const depth = Math.max(context.amazon_keywords?.length || 0, context.seller_keywords?.length || 0);
    for (let index = 0; index < depth; index += 1) {
      if (context.amazon_keywords?.[index]) queue.push({ raw_keyword: context.amazon_keywords[index], source: "amazon", asins: [context.asin], anchor: context.amazon_keywords?.[0] });
      if (context.seller_keywords?.[index]) queue.push({ raw_keyword: context.seller_keywords[index], source: "sellersprite", asins: [context.asin], anchor: context.amazon_keywords?.[0] });
    }
    return queue;
  });
  const depth = Math.max(0, ...queues.map((queue) => queue.length));
  for (let index = 0; index < depth; index += 1) {
    for (const queue of queues) if (queue[index]) rows.push(queue[index]);
  }

  const sourceRawKeywordCount = rows.length;
  const requestedLimit = String(args["max-queries"] || "12").toLowerCase();
  const numericLimit = requestedLimit === "all" ? null : Math.max(0, Number(requestedLimit));
  let cleaned = cleanKeywordCandidates(rows);
  if (numericLimit !== null && cleaned.length < numericLimit) {
    const expansionQueues = productContexts.map(deriveExpansionCandidates);
    const maxDepth = Math.max(0, ...expansionQueues.map((queue) => queue.length));
    outer: for (let index = 0; index < maxDepth; index += 1) {
      for (const queue of expansionQueues) {
        if (!queue[index]) continue;
        rows.push(queue[index]);
        cleaned = cleanKeywordCandidates(rows);
        if (cleaned.length >= numericLimit) break outer;
      }
    }
  }
  const limit = numericLimit === null ? cleaned.length : numericLimit;
  const queries = cleaned.slice(0, limit).map((row) => ({ ...row, search_url: searchUrl(row.query) }));
  return {
    raw_candidates: rows,
    raw_keyword_count: rows.length,
    source_raw_keyword_count: sourceRawKeywordCount,
    derived_keyword_count: rows.length - sourceRawKeywordCount,
    effective_keyword_count: cleaned.length,
    max_queries: limit,
    queries,
  };
}

function buildQueries(args, productContexts = []) {
  return buildKeywordPlan(args, productContexts).queries;
}

function planQuerySearches(queries, videosPerQuery = DEFAULT_VIDEOS_PER_QUERY) {
  const candidateLimit = Math.max(1, Number(videosPerQuery) || DEFAULT_VIDEOS_PER_QUERY);
  return queries.map((query) => ({ ...query, candidate_limit: candidateLimit }));
}

function deduplicateSearchCandidates(batches) {
  const candidates = [];
  const byId = new Map();
  let searchCandidateCount = 0;
  for (const batch of batches) {
    for (const row of batch) {
      searchCandidateCount += 1;
      const existing = byId.get(row.video_id);
      if (existing) {
        existing.asins = unique([...(existing.asins || []), ...(row.asins || [])]);
        existing.keyword_sources = unique([...(existing.keyword_sources || []), ...(row.keyword_sources || [])]);
        existing.matched_queries = unique([...(existing.matched_queries || [existing.query]), row.query].filter(Boolean));
        continue;
      }
      const candidate = { ...row, matched_queries: row.query ? [row.query] : [] };
      byId.set(row.video_id, candidate);
      candidates.push(candidate);
    }
  }
  return {
    candidates,
    search_candidate_count: searchCandidateCount,
    duplicate_video_count: searchCandidateCount - candidates.length,
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(Number(concurrency) || 1)));
  let cursor = 0;
  await Promise.all(Array.from({ length: workerCount }, async (_, workerIndex) => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index, workerIndex);
    }
  }));
  return results;
}

async function autoScroll(page, rounds = 8) {
  let previousHeight = 0;
  for (let index = 0; index < rounds; index += 1) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(900);
    if (height === previousHeight) break;
    previousHeight = height;
  }
}

async function acceptConsentIfVisible(page) {
  const labels = [
    "Accept all",
    "I agree",
    "Agree",
    "Reject all",
    "No thanks",
  ];
  for (const label of labels) {
    const button = page.getByRole("button", { name: new RegExp(label, "i") }).first();
    try {
      if (await button.isVisible({ timeout: 1200 })) {
        await button.click();
        await page.waitForTimeout(800);
        return;
      }
    } catch (_) {
      // Ignore absent consent buttons.
    }
  }
}

async function collectAmazonKeywords(page, asin, limit) {
  const url = `https://www.amazon.com/dp/${encodeURIComponent(asin)}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  const product = await page.evaluate(() => ({
    title: document.querySelector("#productTitle")?.textContent?.replace(/\s+/g, " ").trim() || null,
    bullets: Array.from(document.querySelectorAll("#feature-bullets li span.a-list-item"))
      .map((node) => node.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8),
  }));
  return { asin, url, title: product.title, bullets: product.bullets, amazon_keywords: extractAmazonKeywords(product, limit) };
}

async function collectSellerKeywords(page, asin, excluded, limit) {
  const url = `${SELLERSPRITE_REVERSE_URL}?q=${encodeURIComponent(asin)}&marketId=1`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const button = page.getByRole("button", { name: "立即查询", exact: true }).first();
    if (await button.count()) await button.click({ timeout: 5000 }).catch(() => {});
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const body = await page.locator("body").innerText({ timeout: 5000 });
      const keywords = selectSellerKeywords(body, excluded, limit);
      if (keywords.length) return { url, keywords, status: "available" };
      await page.waitForTimeout(1000);
    }
    return { url, keywords: [], status: "unavailable_or_login_required" };
  } catch (error) {
    return { url, keywords: [], status: "unavailable_or_login_required", note: error.message };
  }
}

async function collectSearchCandidates(page, queryRow, needCount) {
  await page.goto(queryRow.search_url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await acceptConsentIfVisible(page);
  const candidates = [];
  const seen = new Set();
  for (let round = 0; round < 14 && candidates.length < needCount; round += 1) {
    await page.waitForTimeout(1000);
    const rows = await page.evaluate(() => {
      const titleSelectors = [
        "a#video-title[href*='watch?v=']",
        "a.yt-lockup-metadata-view-model-wiz__title[href*='watch?v=']",
        "h3 a[href*='watch?v=']",
        "#video-title-link[href*='watch?v=']",
      ];
      const cleanTitle = (value) => String(value || "")
        .replace(/\s+/g, " ")
        .replace(/\bNow playing\b/ig, "")
        .trim();
      const looksLikeDuration = (value) => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(cleanTitle(value));
      const renderers = Array.from(document.querySelectorAll(
        "ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, .yt-lockup-view-model",
      ));
      return renderers.map((renderer, index) => {
        const anchor = titleSelectors.map((selector) => renderer.querySelector(selector)).find(Boolean);
        if (!anchor) return null;
        const href = anchor.href || anchor.getAttribute("href");
        const title = cleanTitle(anchor.getAttribute("title") || anchor.getAttribute("aria-label") || anchor.textContent);
        if (!href || !title || looksLikeDuration(title)) return null;
        const channel = renderer ? (renderer.querySelector("ytd-channel-name a, .yt-core-attributed-string__link")?.textContent || "").trim() : "";
        const metadata = renderer ? Array.from(renderer.querySelectorAll("#metadata-line span, .yt-content-metadata-view-model-wiz__metadata-text")).map((node) => node.textContent.trim()).filter(Boolean) : [];
        return { href, title, channel, metadata, position: index + 1 };
      }).filter(Boolean);
    });
    for (const row of rows) {
      const videoId = videoIdFromUrl(row.href);
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      candidates.push({
        video_id: videoId,
        url: canonicalVideoUrl(videoId),
        title: row.title,
        channel_title: row.channel || null,
        search_metadata: row.metadata,
        search_position: row.position,
        query: queryRow.query,
        search_dimension: queryRow.dimension,
        search_url: queryRow.search_url,
        asins: queryRow.asins || [],
        keyword_sources: queryRow.keyword_sources || [],
      });
      if (candidates.length >= needCount) break;
    }
    if (candidates.length >= needCount) break;
    await page.mouse.wheel(0, 2200);
  }
  return candidates;
}

async function expandDescription(page) {
  const selectors = [
    "tp-yt-paper-button#expand",
    "ytd-text-inline-expander tp-yt-paper-button",
    "#description-inline-expander #expand",
    "button[aria-label*='more']",
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 800 })) {
        await locator.click({ timeout: 1500 });
        await page.waitForTimeout(500);
        return;
      }
    } catch (_) {
      // Ignore non-visible expand controls.
    }
  }
}

async function loadCommentsUntil(page, maxComments) {
  const comments = page.locator("ytd-comment-thread-renderer");
  let count = await comments.count();
  let stagnantRounds = 0;
  while (count < maxComments && stagnantRounds < 3) {
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(1000);
    const nextCount = await comments.count();
    stagnantRounds = nextCount > count ? 0 : stagnantRounds + 1;
    count = nextCount;
  }
  return { count: Math.min(count, maxComments), stagnant_rounds: stagnantRounds };
}

async function countVisibleCommentNodes(page) {
  return page.locator("ytd-comment-thread-renderer #content-text").count();
}

async function expandReplyControls(page, maxActions = 40, onAction = async () => {}) {
  const ledger = [];
  for (let action = 0; action < maxActions; action += 1) {
    const controls = page.locator("ytd-comment-replies-renderer #more-replies, ytd-comment-replies-renderer #continuation button, ytd-comment-thread-renderer #more-replies, ytd-comment-replies-renderer button");
    const count = await controls.count();
    let clicked = false;
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      try {
        if (!(await control.isVisible({ timeout: 250 }))) continue;
        const label = `${await control.textContent().catch(()=>"")} ${await control.getAttribute("aria-label").catch(()=>"")}`.replace(/\s+/g," ").trim();
        const id = await control.getAttribute("id").catch(()=>"");
        if (!/more-replies|continuation/.test(id || "") && !vocCore.isReplyExpansionLabel(label)) continue;
        const before = await countVisibleCommentNodes(page);
        const controlKey = `${index}:${label}`;
        await control.click({ timeout: 1800 });
        await page.waitForTimeout(700);
        const after = await countVisibleCommentNodes(page);
        const row = { action_type:"expand_replies", control_key:controlKey, new_comment_ids:[], current_comment_count:after, current_max_depth:1, remaining_reply_controls:Math.max(0,count-index-1), added_count:Math.max(0,after-before) };
        ledger.push(row); await onAction(row); clicked = true; break;
      } catch (_) { /* stale or inaccessible control */ }
    }
    if (!clicked) break;
  }
  return ledger;
}

function classifyNoCommentState({ bodyText = "" } = {}) {
  const text = String(bodyText);
  if (/comments are turned off|comments (?:have been )?disabled/i.test(text)) return "comments_disabled";
  if (/age[- ]restricted|confirm your age|not available in your (?:country|region)|blocked in your (?:country|region)/i.test(text)) return "age_or_region_restricted";
  if (/video unavailable|this video (?:isn't|is not) available|private video|has been removed/i.test(text)) return "video_unavailable";
  if (/sign in to continue(?: to youtube)?|log in to continue|sign in to view/i.test(text)) return "login_required";
  if (/\b0 comments?\b|no comments yet|be the first to comment/i.test(text)) return "zero_comments";
  return "unknown_no_public_comments";
}

function classifyVideoError(error) {
  return /timeout|timed out/i.test(String(error?.message || error)) ? "load_timeout" : "unknown_no_public_comments";
}

async function collectVideoDetail(page, candidate, commentsPerVideo, options = {}) {
  const url = `${candidate.url}&hl=en`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await acceptConsentIfVisible(page);
  await page.waitForTimeout(1400);
  await expandDescription(page);
  await autoScroll(page, 2);
  const loadState = await loadCommentsUntil(page, commentsPerVideo);
  const actionLedger = await expandReplyControls(page, Number(options.maxReplyActions || 40), options.onReplyAction);

  const detail = await page.evaluate((maxComments) => {
    const textOf = (selector) => {
      const node = document.querySelector(selector);
      return node ? (node.textContent || "").replace(/\s+/g, " ").trim() : null;
    };
    const attrOf = (selector, attr) => {
      const node = document.querySelector(selector);
      return node ? node.getAttribute(attr) : null;
    };
    const title = textOf("h1 yt-formatted-string, h1 title, h1");
    const description =
      textOf("#description-inline-expander #description-text, ytd-text-inline-expander #content, #description #content, #description") ||
      attrOf("meta[name='description']", "content");
    const channelTitle =
      textOf("ytd-video-owner-renderer ytd-channel-name a, #owner ytd-channel-name a, ytd-channel-name a") ||
      attrOf("link[itemprop='name']", "content");
    const channelUrl = document.querySelector("ytd-video-owner-renderer ytd-channel-name a, #owner ytd-channel-name a, ytd-channel-name a")?.href || null;
    const publishedText = textOf("#info-strings yt-formatted-string, ytd-watch-info-text span");
    const viewText = textOf("#info #count .view-count, #count .view-count, ytd-watch-info-text #info");
    const readComment = (node, index, parentCommentId = null, depth = 0) => {
      const content = node.querySelector("#content-text")?.textContent?.replace(/\s+/g, " ").trim() || null;
      const author = node.querySelector("#author-text")?.textContent?.replace(/\s+/g, " ").trim() || null;
      const authorUrl = node.querySelector("#author-text")?.href || null;
      const timeText = node.querySelector(".published-time-text a, #published-time-text a")?.textContent?.replace(/\s+/g, " ").trim() || null;
      const likeText = node.querySelector("#vote-count-middle")?.textContent?.replace(/\s+/g, " ").trim() || null;
      const commentUrl = node.querySelector(".published-time-text a, #published-time-text a")?.href || null;
      let commentId = null;
      try { commentId = new URL(commentUrl).searchParams.get("lc"); } catch (_) { /* no permalink */ }
      const isPinned = Boolean(node.querySelector("ytd-pinned-comment-badge-renderer"));
      const isCreatorHearted = Boolean(node.querySelector("#creator-heart, ytd-creator-heart-renderer"));
      return { content, author, authorUrl, timeText, likeText, commentUrl, commentId, parentCommentId, depth, isPinned, isCreatorHearted, position: index + 1 };
    };
    const comments = [];
    for (const [threadIndex, thread] of Array.from(document.querySelectorAll("ytd-comment-thread-renderer")).entries()) {
      const topNode = thread.querySelector(":scope > #comment, :scope > ytd-comment-view-model, :scope > ytd-comment-renderer") || thread;
      const top = readComment(topNode, comments.length, null, 0);
      if (top.content) comments.push(top);
      const topId = top.commentId || `visible-top-${threadIndex + 1}`;
      const replies = thread.querySelectorAll("ytd-comment-replies-renderer ytd-comment-renderer, ytd-comment-replies-renderer ytd-comment-view-model");
      for (const reply of replies) {
        const row = readComment(reply, comments.length, topId, 1);
        if (row.content) comments.push(row);
      }
      if (comments.length >= maxComments) break;
    }
    comments.splice(maxComments);
    return { title, description, channelTitle, channelUrl, publishedText, viewText, comments, bodyText: (document.body?.innerText || "").slice(0, 100000) };
  }, commentsPerVideo);

  detail.no_comment_reason = detail.comments.length ? null : classifyNoCommentState({ bodyText: detail.bodyText });
  delete detail.bodyText;
  detail.action_ledger = actionLedger;
  const remainingControls = page.locator("ytd-comment-replies-renderer #more-replies, ytd-comment-replies-renderer #continuation button, ytd-comment-replies-renderer button");
  let remainingReplyControls = 0;
  for (let index=0; index<await remainingControls.count(); index+=1) {
    const control=remainingControls.nth(index); if (!(await control.isVisible().catch(()=>false))) continue;
    const label=`${await control.textContent().catch(()=>"")} ${await control.getAttribute("aria-label").catch(()=>"")}`;
    if (vocCore.isReplyExpansionLabel(label) || /more-replies|continuation/.test(await control.getAttribute("id").catch(()=>"") || "")) remainingReplyControls+=1;
  }
  detail.remaining_reply_controls = remainingReplyControls;
  detail.current_max_depth = detail.comments.reduce((max, row) => Math.max(max, row.depth || 0), 0);
  detail.stagnant_rounds = loadState.stagnant_rounds;
  detail.visible_comment_count = loadState.count;

  return detail;
}

function rawCommentRecord(candidate, detail, comment, args, collectedAt) {
  const videoId = candidate.video_id;
  const commentKey = comment.commentUrl || `${candidate.url}#comment-${comment.position}-${comment.content}`;
  const commentId = comment.commentId || hashId(commentKey);
  const matchedAsins = candidate.matched_asins || candidate.asins || [];
  const matchedKeywords = candidate.matched_queries || [candidate.query];
  return {
    schema_version: "voc_raw_v1",
    source: "youtube",
    record_type: "comment",
    source_item_id: `comment:${videoId}:${commentId}`,
    source_parent_id: `video:${videoId}`,
    platform: "youtube",
    asin: matchedAsins[0] || null,
    matched_asins: matchedAsins,
    amazon_asins: matchedAsins,
    query: candidate.query,
    matched_query: candidate.query,
    matched_keywords: matchedKeywords,
    keyword_sources: candidate.keyword_sources || [],
    discovery_round: candidate.discovery_round || 1,
    relevance_tier: null,
    video_id: videoId,
    video_title: detail.title || candidate.title || null,
    video_url: candidate.url,
    channel_id: null,
    channel_title: detail.channelTitle || candidate.channel_title || null,
    channel_url: detail.channelUrl || null,
    comment_id: commentId,
    parent_comment_id: comment.parentCommentId || null,
    depth: Number(comment.depth || 0),
    author_channel_url: comment.authorUrl || null,
    body: comment.content,
    comment_text: comment.content,
    like_count: comment.likeText || null,
    is_pinned: comment.isPinned,
    is_creator_hearted: comment.isCreatorHearted,
    created_at_or_visible_time: comment.timeText || null,
    published_at: comment.timeText || null,
    comment_url: comment.commentUrl || candidate.url,
    audit_status: null,
    collected_at: collectedAt,
    observed_at: null,
    query_context: {
      query: candidate.query,
      topic: (args.asins || []).join(","),
      filters: {
        target_videos: Number(args["target-videos"] || DEFAULT_TARGET_VIDEOS),
        comments_per_video: Number(args["comments-per-video"] || DEFAULT_COMMENTS_PER_VIDEO),
        search_dimension: candidate.search_dimension,
        amazon_asins: matchedAsins,
        keyword_sources: candidate.keyword_sources || [],
      },
      collector: "playwright-chrome-search-detail-comments",
    },
    provenance: {
      url: comment.commentUrl || candidate.url,
      thread_url: candidate.url,
      position: comment.position,
      capture_method: "playwright-chrome-search-detail-comments",
      access_notes: null,
    },
    content: {
      title: detail.title || candidate.title || null,
      text: comment.content,
      language: null,
      media_refs: [candidate.url],
    },
    author: {
      handle: comment.author || null,
      profile_url: comment.authorUrl || null,
      is_verified: null,
    },
    engagement: {
      score: null,
      rating: null,
      likes: comment.likeText || null,
      replies: null,
      views: null,
    },
    source_specific: {
      video_id: videoId,
      video_title: detail.title || candidate.title || null,
      video_url: candidate.url,
      channel_title: detail.channelTitle || candidate.channel_title || null,
      channel_url: detail.channelUrl || null,
      record_type: "comment",
      amazon_asins: matchedAsins,
      keyword_sources: candidate.keyword_sources || [],
      published_text: detail.publishedText || null,
      view_text: detail.viewText || null,
      comment_time_text: comment.timeText || null,
      is_pinned: comment.isPinned,
    },
  };
}

function buildCommentRecords(candidate, detail, args, collectedAt) {
  return detail.comments.map((comment) => rawCommentRecord(candidate, detail, comment, args, collectedAt));
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function recordsToCsv(records) {
  const columns = [
    "source",
    "source_item_id",
    "comment_id",
    "parent_comment_id",
    "depth",
    "source_parent_id",
    "url",
    "thread_url",
    "query",
    "topic",
    "amazon_asins",
    "keyword_sources",
    "video_id",
    "video_title",
    "video_url",
    "channel_title",
    "channel_url",
    "title",
    "comment_text",
    "author",
    "published_at",
    "like_count",
    "collected_at",
    "record_type",
    "source_specific_json",
  ];
  const lines = [columns.join(",")];
  for (const row of records) {
    const values = [
      row.source,
      row.source_item_id,
      row.comment_id,
      row.parent_comment_id,
      row.depth,
      row.source_parent_id,
      row.provenance?.url,
      row.provenance?.thread_url,
      row.query_context?.query,
      row.query_context?.topic,
      row.source_specific?.amazon_asins,
      row.source_specific?.keyword_sources,
      row.source_specific?.video_id,
      row.source_specific?.video_title,
      row.source_specific?.video_url,
      row.source_specific?.channel_title,
      row.source_specific?.channel_url,
      row.content?.title,
      row.content?.text,
      row.author?.handle,
      row.created_at_or_visible_time || row.timestamps?.published_at || row.source_specific?.comment_time_text,
      row.like_count ?? row.engagement?.like_count ?? row.engagement?.likes,
      row.collected_at,
      row.source_specific?.record_type,
      row.source_specific,
    ];
    lines.push(values.map(csvEscape).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function qualityGate(records, targetVideos) {
  const seen = new Set();
  const videoParents = new Set();
  const commentIds = new Set(records.map(record => record.comment_id).filter(Boolean));
  let duplicateCount = 0;
  let missingId = 0;
  let missingParentId = 0;
  let missingUrl = 0;
  let missingText = 0;
  let malformedUrl = 0;
  let commentCount = 0;
  let replyCount = 0;
  let orphanReplyCount = 0;
  let unexpectedRecordTypeCount = 0;
  for (const record of records) {
    if (!record.source_item_id) {
      missingId += 1;
    } else {
      if (seen.has(record.source_item_id)) duplicateCount += 1;
      seen.add(record.source_item_id);
    }
    if (!record.provenance?.url) missingUrl += 1;
    if (!record.content?.text) missingText += 1;
    try {
      if (record.provenance?.url) new URL(record.provenance.url);
    } catch (_) {
      malformedUrl += 1;
    }
    if (record.source_specific?.record_type === "comment") {
      commentCount += 1;
      if (record.parent_comment_id) {
        replyCount += 1;
        if (!commentIds.has(record.parent_comment_id)) orphanReplyCount += 1;
      }
      if (record.source_parent_id) videoParents.add(record.source_parent_id);
      else missingParentId += 1;
    } else unexpectedRecordTypeCount += 1;
  }
  const videoCount = videoParents.size;
  const hasIntegrityIssues = missingId + missingParentId + missingUrl + missingText + duplicateCount + orphanReplyCount + malformedUrl + unexpectedRecordTypeCount > 0;
  const decision = records.length === 0 ? "fail" : !hasIntegrityIssues ? "pass" : "warning";
  return {
    gate: "acquisition_quality_gate",
    stage: "post_collection",
    decision,
    can_continue: records.length > 0,
    blocking_issues: records.length ? [] : ["no_records_collected"],
    recommended_actions: decision === "warning" ? ["Inspect missing fields, technical duplicates, parent lineage, URLs, and record types."] : [],
    metrics: {
      target_count: targetVideos,
      captured_count: records.length,
      captured_video_count: videoCount,
      captured_comment_count: commentCount,
      main_comment_count: commentCount - replyCount,
      reply_count: replyCount,
      orphan_reply_count: orphanReplyCount,
      missing_id_count: missingId,
      missing_parent_id_count: missingParentId,
      missing_url_count: missingUrl,
      missing_text_count: missingText,
      duplicate_id_count: duplicateCount,
      malformed_url_count: malformedUrl,
      unexpected_record_type_count: unexpectedRecordTypeCount,
    },
  };
}

function classifyAccessPage(text = "") {
  const value = String(text);
  if (/captcha|unusual traffic|verify (?:you are|that you're) human/i.test(value)) return "captcha";
  if (/too many requests|rate limit|try again later/i.test(value)) return "rate_limited";
  if (/access denied|forbidden/i.test(value)) return "access_denied";
  if (/sign in to continue|log in to continue/i.test(value)) return "login_required";
  if (/confirm your age|age[- ]restricted/i.test(value)) return "age_restricted";
  if (/not available in your (?:country|region)|region restricted/i.test(value)) return "region_restricted";
  if (/comments are turned off|comments disabled/i.test(value)) return "comments_unavailable";
  if (/video unavailable|page not found/i.test(value)) return "unavailable";
  return "ready";
}

async function runPreflightCommand(parsedArgs) {
  if (parsedArgs.fixture) {
    const fixture = JSON.parse(await fs.readFile(path.resolve(parsedArgs.fixture), "utf8"));
    const probe = (name) => async () => fixture[name] || "unavailable";
    const result = await vocCore.runPreflight({ amazon:probe("amazon"), seller:probe("seller"), youtube:probe("youtube"), video:probe("video"), comments:probe("comments") });
    console.log(JSON.stringify({ mode:"preflight", ...result }, null, 2));
    return result;
  }
  const args = await promptIfMissing(parsedArgs);
  const chromium = loadPlaywrightChromium();
  const profileDir = path.resolve(process.cwd(), args["profile-dir"] || ".youtube-voc-browser-profile");
  await fs.mkdir(profileDir,{recursive:true});
  const browser = await chromium.launchPersistentContext(profileDir,{headless:String(args.headless ?? "1") !== "0",channel:args.channel || DEFAULT_BROWSER_CHANNEL,locale:"en-US",viewport:{width:1360,height:900}});
  const page = await browser.newPage(); page.setDefaultTimeout(15000);
  const visit = async (url) => { try { await page.goto(url,{waitUntil:"domcontentloaded",timeout:30000}); return classifyAccessPage((await page.locator("body").innerText()).slice(0,60000)); } catch (error) { return classifyVideoError(error) === "load_timeout" ? "unavailable" : "access_denied"; } };
  try {
    let firstVideo = null;
    const amazon = await visit(`https://www.amazon.com/dp/${args.asins[0]}`);
    const seller = await visit(`${SELLERSPRITE_REVERSE_URL}${args.asins[0]}`);
    const youtube = await visit(`https://www.youtube.com/results?search_query=${encodeURIComponent(args.asins[0])}`);
    if (youtube === "ready") firstVideo = await page.locator("a#video-title").first().getAttribute("href").catch(() => null);
    const video = firstVideo ? await visit(new URL(firstVideo,"https://www.youtube.com").href) : "unavailable";
    if (video === "ready") { await page.mouse.wheel(0,1600); await page.waitForTimeout(1000); }
    const comments = video !== "ready" ? video : (await page.locator("ytd-comments, ytd-comment-thread-renderer").count()) ? "ready" : classifyAccessPage((await page.locator("body").innerText()).slice(0,60000)) === "ready" ? "comments_unavailable" : classifyAccessPage((await page.locator("body").innerText()).slice(0,60000));
    const result = {mode:"preflight",amazon,seller,youtube,video,comments,ready:[amazon,youtube,video,comments].every(x=>x==="ready"),formal_collection_started:false};
    console.log(JSON.stringify(result,null,2)); return result;
  } finally { await browser.close(); }
}

async function main() {
  const parsedArgs = parseArgs(process.argv);
  if (parsedArgs.help) { console.log(USAGE.trim()); return; }
  if (parsedArgs.command === "preflight") { await runPreflightCommand(parsedArgs); return; }
  const args = await promptIfMissing(parsedArgs);
  const targetVideos = Math.max(1, Number(args["target-videos"] || DEFAULT_TARGET_VIDEOS));
  const targetComments = Math.max(1, Number(args["target-comments"] || DEFAULT_TARGET_COMMENTS));
  const commentsPerVideo = Math.max(1, Number(args["max-comments-per-video"] || args["comments-per-video"] || DEFAULT_COMMENTS_PER_VIDEO));
  const videosPerQuery = Math.max(1, Number(args["videos-per-query"] || DEFAULT_VIDEOS_PER_QUERY));
  const detailConcurrency = Math.min(6, Math.max(1, Math.floor(Number(args["detail-concurrency"] || DEFAULT_DETAIL_CONCURRENCY))));
  const maxRounds = Math.max(1, Number(args["max-discovery-rounds"] || 3));
  const minNew = Math.max(0, Number(args["min-new-comments-per-round"] || 5));
  const duplicateRateStop = Math.min(1, Math.max(0, Number(args["duplicate-rate-stop"] || .85)));
  const maxFailures = Math.max(1, Number(args["max-failures"] || 5));
  const outDir = path.resolve(process.cwd(), args["out-dir"] || DEFAULT_OUT_DIR);
  const profileDir = path.resolve(process.cwd(), args["profile-dir"] || ".youtube-voc-browser-profile");
  const collectedAt = nowIso(), date = collectedAt.slice(0,10), topicSlug = slugify(args.asins.join("_"));
  const prefix = `${date}_${topicSlug}_youtube`;
  const paths = {
    raw:path.join(outDir,`${prefix}_raw_comments.jsonl`),
    csv:path.join(outDir,`${prefix}_comments_raw.csv`), keywords:path.join(outDir,`${prefix}_asin_keywords.json`),
    conversation:path.join(outDir,`${prefix}_conversation_map.json`), query:path.join(outDir,`${prefix}_query_plan.json`),
    channelMap:path.join(outDir,`${prefix}_community_or_channel_map.json`), manifest:path.join(outDir,`${prefix}_manifest.json`),
    checkpoint:path.join(outDir,`${prefix}_checkpoint.json`), excel:path.join(outDir,`${args.asins.join("_")}_${collectedAt.replace(/[:.]/g,"-")}_youtube_voc.xlsx`),
    evidence:path.join(outDir,"evidence"),
  };
  await fs.mkdir(paths.evidence,{recursive:true}); await fs.mkdir(profileDir,{recursive:true});
  let checkpoint = args.resume ? vocCore.loadCheckpoint(path.resolve(args.resume)) : vocCore.emptyCheckpoint();
  checkpoint.input_asins = args.asins;
  const existingRaw = args.resume && await fileExists(paths.raw) ? await readJsonl(paths.raw) : [];
  const existingManifest = args.resume && await fileExists(paths.manifest) ? JSON.parse(await fs.readFile(paths.manifest,"utf8")) : {};
  let allComments = vocCore.mergeComments(existingRaw);

  const chromium = loadPlaywrightChromium();
  const launchOptions = {headless:String(args.headless ?? "1") !== "0" && String(args["headed-login"] ?? "0") !== "1",viewport:{width:1360,height:900},locale:"en-US",args:["--window-position=40,40","--window-size=1360,900","--disable-blink-features=AutomationControlled"]};
  if (args["executable-path"]) launchOptions.executablePath = await ensureChromiumExecutable(chromium,args["executable-path"]); else launchOptions.channel = args.channel || DEFAULT_BROWSER_CHANNEL;
  const browser = await chromium.launchPersistentContext(profileDir,launchOptions);
  const searchPage = await browser.newPage(); searchPage.setDefaultTimeout(20000);
  const detailPages = await Promise.all(Array.from({length:detailConcurrency},async()=>{const p=await browser.newPage();p.setDefaultTimeout(Number(args["video-timeout"] || 60000));return p;}));
  let productContexts = checkpoint.product_contexts || [], keywordPlan, conversationMap, queryPlan = checkpoint.query_plan || [];
  let allCandidates = [], videoAudits = existingManifest.video_audits || [], rounds = existingManifest.rounds || [], failures = 0;
  let rawCommentCount = existingManifest.raw_captured_count || existingManifest.raw_comment_count || allComments.length, filteredCount = existingManifest.filtered_count || checkpoint.filtered_count || 0;
  let duplicateCount = checkpoint.duplicate_comment_count || 0, duplicateVideoCount = checkpoint.duplicate_video_count || 0, stop = {stop:false,stop_reason:null};
  try {
    if (!productContexts.length) {
      const sellerPage = await browser.newPage();
      for (const asin of args.asins) {
        let amazon;
        try { amazon = {...await collectAmazonKeywords(searchPage,asin,Number(args["amazon-term-limit"] || 8)),status:"available",amazon_login_status:"not_required"}; }
        catch (error) { amazon={asin,url:`https://www.amazon.com/dp/${asin}`,title:null,bullets:[],amazon_keywords:[asin],status:classifyAccessPage(error.message),amazon_login_status:"unknown",note:error.message}; }
        const seller = await collectSellerKeywords(sellerPage,asin,amazon.amazon_keywords,Number(args["seller-term-limit"] || 30));
        productContexts.push({...amazon,product_title:amazon.title,brand:productAnchor(amazon.title),category:null,common_product_names:amazon.title?[amazon.title]:[],core_attributes:amazon.bullets,primary_functions:[],ingredients_or_components:[],use_cases:[],user_problems:[],pain_points:[],competing_products:[],seller_url:seller.url,seller_status:seller.status,seller_note:seller.note || null,seller_keywords:seller.keywords});
      }
      await sellerPage.close(); checkpoint.product_contexts = productContexts; vocCore.saveCheckpoint(paths.checkpoint,checkpoint);
    }
    keywordPlan = buildKeywordPlan(args,productContexts);
    conversationMap = vocCore.buildConversationMap(productContexts);
    await fs.writeFile(paths.keywords,JSON.stringify({asins:args.asins,product_contexts:productContexts,...keywordPlan},null,2),"utf8");
    await fs.writeFile(paths.conversation,JSON.stringify(conversationMap,null,2),"utf8");
    if (!queryPlan.length) queryPlan = planQuerySearches(keywordPlan.queries,videosPerQuery).map(row=>({...row,query_family:row.dimension,generation_source:row.keyword_sources?.includes("manual")?"user_expanded_keyword":row.dimension,source_video_ids:[],evidence_comment_ids:[],matched_asins:row.asins,semantic_link:"product-source seed",discovery_round:1,priority:100,executed:false,videos_found:0,trusted_comments_found:0,marginal_yield:0}));
    if (args.resume) vocCore.requeueQueriesForResume(checkpoint,targetComments);

    for (let round = Math.max(1,checkpoint.discovery_round || 1); round <= maxRounds; round += 1) {
      const roundQueries = queryPlan.filter(row => row.discovery_round === round && !row.executed);
      if (!roundQueries.length) { stop={stop:true,stop_reason:"semantic_saturation"}; break; }
      const beforeCollected = allComments.length, beforeRaw = rawCommentCount;
      const batches = [];
      for (const query of roundQueries) {
        try {
          await randomDelay(Number(args["navigation-delay-min"] || 600),Number(args["navigation-delay-max"] || 1200),searchPage);
          const rows = await collectSearchCandidates(searchPage,{...query,search_url:query.search_url || searchUrl(query.query)},videosPerQuery);
          query.executed=true;query.videos_found=rows.length;batches.push(rows.map(row=>({...row,discovery_round:round,matched_asins:query.matched_asins || query.asins})));
          checkpoint.searched_queries=unique([...(checkpoint.searched_queries || []),query.query]);checkpoint.query_plan=queryPlan;vocCore.saveCheckpoint(paths.checkpoint,checkpoint);
        } catch (error) {
          failures += 1; query.executed=true;query.error=error.message;vocCore.saveCheckpoint(paths.checkpoint,checkpoint);
          const access = classifyAccessPage(error.message); if (vocCore.shouldCircuitBreak(access) || failures >= maxFailures) { stop={stop:true,stop_reason:vocCore.shouldCircuitBreak(access)?`access_${access}`:"max_failures"}; break; }
        }
      }
      const merged = deduplicateSearchCandidates(batches); duplicateVideoCount += merged.duplicate_video_count;
      allCandidates = vocCore.dedupeVideos([...allCandidates,...merged.candidates]);
      const remainingSlots = Math.max(0,targetVideos - Object.keys(checkpoint.video_audits || {}).length);
      const visit = allCandidates.filter(candidate=>vocCore.shouldVisitVideo(checkpoint,candidate.video_id,{retryPartial:Boolean(args["retry-partial"]),forceReauditPartial:Boolean(args["force-reaudit-partial"])})).slice(0,remainingSlots);
      for (let offset=0; offset<visit.length && !stop.stop; offset += detailPages.length) {
        const batch = visit.slice(offset,offset+detailPages.length);
        const results = await Promise.all(batch.map(async(candidate,index)=>{
          const evidenceDir=path.join(paths.evidence,candidate.video_id);await fs.mkdir(evidenceDir,{recursive:true});
          try {
            await randomDelay(Number(args["navigation-delay-min"] || 600),Number(args["navigation-delay-max"] || 1200),detailPages[index]);
            const detail=await collectVideoDetail(detailPages[index],candidate,commentsPerVideo,{maxReplyActions:Number(args["max-reply-actions"] || 40),onReplyAction:async action=>{checkpoint.expanded_reply_controls.push({video_id:candidate.video_id,...action});vocCore.saveCheckpoint(paths.checkpoint,checkpoint);}});
            const relevance=vocCore.scoreVideoRelevance({title:detail.title || candidate.title,description:detail.description},conversationMap);
            const audit=vocCore.auditVideo({relevant:relevance.relevant,access_state:detail.no_comment_reason || "ready",remaining_reply_controls:detail.remaining_reply_controls,orphan_count:0,stagnant_rounds:detail.visible_comment_count>=commentsPerVideo?3:detail.stagnant_rounds});
            let records=buildCommentRecords(candidate,detail,args,collectedAt).map(row=>({...row,...vocCore.classifyCommentRelevance(row,conversationMap),audit_status:audit.audit_status,source_specific:{...row.source_specific,audit_status:audit.audit_status}}));
            const before=records.length;records=records.filter(vocCore.isValidComment);filteredCount += before-records.length;rawCommentCount += before;
            const auditRow={video_id:candidate.video_id,video_title:detail.title || candidate.title,video_url:candidate.url,channel_id:null,channel_title:detail.channelTitle || candidate.channel_title,channel_url:detail.channelUrl,published_at_or_visible_time:detail.publishedText,visible_view_count:detail.viewText,visible_comment_count:detail.visible_comment_count,matched_query:candidate.query,matched_keywords:candidate.matched_queries,matched_asins:candidate.matched_asins || candidate.asins,relevance_score:relevance.relevance_score,audit_status:audit.audit_status,audit_reason:audit.reason};
            await writeEvidence(evidenceDir,auditRow,records,detail);
            return {candidate,records,audit:auditRow};
          } catch(error) {
            const state=classifyVideoError(error);const auditRow={video_id:candidate.video_id,video_title:candidate.title,video_url:candidate.url,matched_query:candidate.query,matched_asins:candidate.matched_asins || candidate.asins,relevance_score:0,audit_status:"BLOCKED",audit_reason:state,note:error.message};await writeEvidence(evidenceDir,auditRow,[],{action_ledger:[],remaining_reply_controls:0});return {candidate,records:[],audit:auditRow};
          }
        }));
        for (const result of results) {
          videoAudits=videoAudits.filter(x=>x.video_id!==result.audit.video_id);videoAudits.push(result.audit);
          const prior=allComments.length;allComments=vocCore.mergeComments([...allComments,...result.records]);duplicateCount += Math.max(0,prior+result.records.length-allComments.length);
          checkpoint.video_audits[result.audit.video_id]=result.audit.audit_status;
          checkpoint.completed_video_ids=unique(Object.entries(checkpoint.video_audits).filter(([,s])=>s==="PASS").map(([id])=>id));
          checkpoint.partial_video_ids=unique(Object.entries(checkpoint.video_audits).filter(([,s])=>s==="PARTIAL").map(([id])=>id));
          checkpoint.blocked_video_ids=unique(Object.entries(checkpoint.video_audits).filter(([,s])=>s==="BLOCKED").map(([id])=>id));
          checkpoint.collected_comment_ids=unique(allComments.map(x=>x.comment_id || x.source_item_id));checkpoint.final_collected_count=allComments.length;checkpoint.raw_captured_count=rawCommentCount;checkpoint.technical_duplicate_count=duplicateCount;checkpoint.filtered_count=filteredCount;checkpoint.duplicate_count=duplicateCount;checkpoint.duplicate_comment_count=duplicateCount;checkpoint.duplicate_video_count=duplicateVideoCount;vocCore.saveCheckpoint(paths.checkpoint,checkpoint);
        }
        if (allComments.length>=targetComments) stop={stop:true,stop_reason:"target_comments_reached"};
      }
      const newCollected=allComments.length-beforeCollected;
      const roundMetric={round,new_collected:newCollected,new_trusted:newCollected,new_raw:rawCommentCount-beforeRaw,duplicate_rate:(rawCommentCount-beforeRaw)>0?Math.max(0,1-newCollected/(rawCommentCount-beforeRaw)):0,queries_executed:roundQueries.length,new_videos:visit.length};rounds.push(roundMetric);
      for(const query of roundQueries){query.collected_comments_found=newCollected;query.marginal_yield=roundQueries.length?newCollected/roundQueries.length:0;}
      stop=stop.stop?stop:vocCore.evaluateStop({trusted:allComments.length,targetComments,rounds,maxRounds,minNew,duplicateRateStop,inspectedVideos:Object.keys(checkpoint.video_audits).length,maxVideos:targetVideos});
      if(stop.stop) break;
      const next=vocCore.deriveEvidenceQueries(allComments,round+1,queryPlan,conversationMap).slice(0,Math.max(1,Number(args["max-queries"] === "all" ? 30 : args["max-queries"] || 12))).map(row=>({...row,search_url:searchUrl(row.query),candidate_limit:videosPerQuery,asins:row.matched_asins,keyword_sources:["youtube_evidence"]}));
      queryPlan.push(...next);checkpoint.discovery_round=round+1;checkpoint.query_plan=queryPlan;vocCore.saveCheckpoint(paths.checkpoint,checkpoint);
    }
    allComments=vocCore.reconcileVideoAudits(allComments,checkpoint.video_audits);
    checkpoint.stop_reason=stop.stop_reason || "completed";checkpoint.final_collected_count=allComments.length;checkpoint.raw_captured_count=rawCommentCount;checkpoint.technical_duplicate_count=duplicateCount;vocCore.saveCheckpoint(paths.checkpoint,checkpoint);
    await fs.writeFile(paths.raw,allComments.map(JSON.stringify).join("\n")+(allComments.length?"\n":""),"utf8");
    await fs.writeFile(paths.csv,recordsToCsv(allComments),"utf8");
    await fs.writeFile(paths.query,JSON.stringify({schema_version:"youtube_query_plan_v2",asins:args.asins,target_comments:targetComments,target_videos:targetVideos,created_at:collectedAt,queries:queryPlan,rounds},null,2),"utf8");
    const channelMap=Object.values(videoAudits.reduce((map,row)=>{const key=row.channel_url || row.channel_title || "unknown";const item=map[key]||{channel_title:row.channel_title,channel_url:row.channel_url,candidate_videos:0,pass_videos:0,trusted_comments:0};item.candidate_videos+=1;item.pass_videos+=row.audit_status==="PASS"?1:0;map[key]=item;return map;},{}));await fs.writeFile(paths.channelMap,JSON.stringify(channelMap,null,2),"utf8");
    const gate=qualityGate(allComments,targetVideos), statusCounts=Object.fromEntries(["PASS","PARTIAL","BLOCKED"].map(status=>[status,videoAudits.filter(x=>x.audit_status===status).length]));
    const mainCommentCount=allComments.filter(row=>!row.parent_comment_id).length, replyCount=allComments.length-mainCommentCount;
    const manifest={schema_version:"youtube_manifest_v3_raw",source:"youtube",collection_layer:"raw",asins:args.asins,input_asin_count:args.asins.length,collected_at:collectedAt,amazon_statuses:productContexts.map(x=>({asin:x.asin,status:x.status})),sellersprite_statuses:productContexts.map(x=>({asin:x.asin,status:x.seller_status,missing_reason:x.seller_note || null})),raw_keyword_count:keywordPlan.raw_keyword_count,effective_keyword_count:keywordPlan.effective_keyword_count,executed_query_count:queryPlan.filter(x=>x.executed).length,search_candidate_count:allCandidates.length+duplicateVideoCount,duplicate_video_count:duplicateVideoCount,deduplicated_video_count:allCandidates.length,video_audit_counts:statusCounts,video_audits:videoAudits,raw_captured_count:rawCommentCount,technical_duplicate_count:duplicateCount,final_collected_count:allComments.length,main_comment_count:mainCommentCount,reply_count:replyCount,filtered_unreadable_count:filteredCount,comments_by_asin:Object.fromEntries(args.asins.map(asin=>[asin,allComments.filter(x=>x.matched_asins?.includes(asin)).length])),rounds,target_comments:targetComments,target_comments_complete:allComments.length>=targetComments,stop_reason:checkpoint.stop_reason,checkpoint_path:paths.checkpoint,video_record_count:0,files:Object.values(paths),quality_checks:[gate],validate_result:gate.decision,comment_count:allComments.length,record_count:allComments.length};
    await fs.writeFile(paths.manifest,JSON.stringify(manifest,null,2),"utf8");
    await buildExcelOutput({jsonlPath:paths.raw,queryPlanPath:paths.query,manifestPath:paths.manifest,excelPath:paths.excel});
    console.log(JSON.stringify({raw_captured_count:rawCommentCount,technical_duplicate_count:duplicateCount,final_collected_count:allComments.length,video_records:0,stop_reason:checkpoint.stop_reason,files:paths},null,2));
  } finally { await Promise.all(detailPages.map(page=>page.close().catch(()=>{}))); await browser.close(); }
}

async function fileExists(file){try{await fs.access(file);return true;}catch{return false;}}
async function readJsonl(file){return (await fs.readFile(file,"utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);}
async function randomDelay(min,max,page){const low=Math.max(0,min),high=Math.max(low,max);await page.waitForTimeout(Math.floor(low+Math.random()*(high-low+1)));}
async function writeEvidence(dir,audit,comments,detail){
  const ids=new Set(comments.map(x=>x.comment_id));const orphans=comments.filter(x=>x.parent_comment_id&&!ids.has(x.parent_comment_id)).map(x=>x.comment_id);
  await Promise.all([
    fs.writeFile(path.join(dir,"audit.json"),JSON.stringify(audit,null,2),"utf8"),
    fs.writeFile(path.join(dir,"comment_tree.json"),JSON.stringify(comments,null,2),"utf8"),
    fs.writeFile(path.join(dir,"frontier.json"),JSON.stringify({remaining_reply_controls:detail.remaining_reply_controls || 0,orphan_comment_ids:orphans,current_max_depth:detail.current_max_depth || 0},null,2),"utf8"),
    fs.writeFile(path.join(dir,"action_ledger.json"),JSON.stringify(detail.action_ledger || [],null,2),"utf8"),
  ]);
}

module.exports = {
  buildCommentRecords,
  buildExcelOutput,
  buildKeywordPlan,
  buildQueries,
  collectVideoDetail,
  classifyNoCommentState,
  classifyVideoError,
  cleanKeywordCandidates,
  countVisibleCommentNodes,
  deduplicateSearchCandidates,
  deriveExpansionCandidates,
  extractAmazonKeywords,
  loadCommentsUntil,
  mapWithConcurrency,
  planQuerySearches,
  qualityGate,
  rawCommentRecord,
  recordsToCsv,
  runPreflightCommand,
  expandReplyControls,
  selectSellerKeywords,
  validateAsins,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    console.error(USAGE);
    process.exit(1);
  });
}

