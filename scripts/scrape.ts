/**
 * Scrapes jewelry-store gold BUYBACK prices ("harga kami beli" — what a store pays
 * you per gram to buy your gold back) from a handful of public Indonesian gold sites,
 * and writes the merged result to data/gold-buyback-prices.json.
 *
 * Usage: npm run scrape
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");
const OUTPUT_PATH = path.join(DATA_DIR, "gold-buyback-prices.json");

const USER_AGENT = "GoldBuybackPricesBot/1.0";
const REQUEST_TIMEOUT_MS = 10_000;
const DELAY_BETWEEN_REQUESTS_MS = 1_500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const buybackStatusSchema = z.enum(["success", "partial", "failed"]);
type BuybackStatus = z.infer<typeof buybackStatusSchema>;

const goldBuybackPriceSchema = z.object({
  storeId: z.string().min(1),
  storeName: z.string().min(1),
  karat: z.number().int().min(1).max(24).nullable(),
  purityPercentage: z.number().min(0).max(100).nullable(),
  buybackPricePerGram: z.number().nonnegative().nullable(),
  sourceUpdatedAt: z.string().nullable(),
  scrapedAt: z.string(),
});
type GoldBuybackPrice = z.infer<typeof goldBuybackPriceSchema>;

interface StoreResult {
  storeId: string;
  storeName: string;
  sourceUrl: string;
  status: BuybackStatus;
  httpStatus: number | null;
  error: string | null;
  prices: GoldBuybackPrice[];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(url: string): Promise<{ ok: boolean; status: number | null; html: string | null; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    });
    if (!response.ok) {
      return { ok: false, status: response.status, html: null, error: `HTTP ${response.status}` };
    }
    return { ok: true, status: response.status, html: await response.text(), error: null };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return { ok: false, status: null, html: null, error: isAbort ? "Timeout" : err instanceof Error ? err.message : "Unknown network error" };
  } finally {
    clearTimeout(timer);
  }
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Recognized hallmark fineness marks; anything else falls back to karat/24*100. */
const HALLMARK_PERCENTAGE: Partial<Record<number, number>> = {
  24: 99.9, 22: 91.6, 20: 83.3, 18: 75.0, 14: 58.5, 10: 41.7, 9: 37.5, 8: 33.3,
};

function percentageFromKarat(karat: number): number | null {
  if (!Number.isInteger(karat) || karat < 1 || karat > 24) return null;
  return HALLMARK_PERCENTAGE[karat] ?? Math.round((karat / 24) * 1000) / 10;
}

function parseKaratLabel(label: string): { karat: number | null; purityPercentage: number | null } {
  const text = label.replace(/,/g, ".").trim();
  const karatMatch = text.match(/(\d{1,2})\s*[kK]\b/) ?? text.match(/\bK\s*(\d{1,2})\b/i);
  const percentMatch = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);

  let karat: number | null = null;
  if (karatMatch) {
    const value = Number(karatMatch[1]);
    if (value >= 1 && value <= 24) karat = value;
  }
  let purityPercentage: number | null = percentMatch ? Number(percentMatch[1]) : null;
  if (purityPercentage === null && karat !== null) purityPercentage = percentageFromKarat(karat);
  return { karat, purityPercentage };
}

/** Parses Indonesian rupiah text ("Rp 2.464.827", "2.244.827/gram") into a plain number. */
function parseRupiah(text: string): number | null {
  const cleaned = text.replace(/rp\.?/gi, "").replace(/\/\s*gram/gi, "").replace(/[^\d,.-]/g, "").trim();
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const normalized = cleaned.replace(/\./g, "").replace(/,/g, ".");
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

const INDONESIAN_MONTHS: Record<string, number> = {
  jan: 0, januari: 0, feb: 1, februari: 1, mar: 2, maret: 2, apr: 3, april: 3,
  mei: 4, jun: 5, juni: 5, jul: 6, juli: 6, agu: 7, agt: 7, agustus: 7,
  sep: 8, september: 8, okt: 9, oktober: 9, nov: 10, november: 10, des: 11, desember: 11,
};

/** Parses a date-only Indonesian text (e.g. "27 Juli 2026") to an ISO string at midnight WIB (UTC+7). */
function parseIndonesianDate(text: string): string | null {
  const match = cleanText(text).match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!match) return null;
  const [, day, monthName, year] = match;
  const monthIndex = INDONESIAN_MONTHS[monthName.toLowerCase()];
  if (monthIndex === undefined) return null;
  const date = new Date(Date.UTC(Number(year), monthIndex, Number(day), -7, 0));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function makeRow(input: Omit<GoldBuybackPrice, "scrapedAt"> & { scrapedAt: string }): GoldBuybackPrice {
  return input;
}

function statusFromRows(prices: GoldBuybackPrice[]): BuybackStatus {
  if (prices.length === 0) return "failed";
  if (prices.some((p) => p.karat === null || p.buybackPricePerGram === null)) return "partial";
  return "success";
}

// ---------------------------------------------------------------------------
// Store scrapers — each reads the store's public "kami beli" (we-buy) table
// ---------------------------------------------------------------------------

async function scrapeIloveemas(): Promise<StoreResult> {
  const storeId = "iloveemas";
  const storeName = "I Love Emas";
  const sourceUrl = "https://iloveemas.co.id/";
  const result = await fetchPage(sourceUrl);
  if (!result.ok || !result.html) {
    return { storeId, storeName, sourceUrl, status: "failed", httpStatus: result.status, error: result.error, prices: [] };
  }

  const $ = cheerio.load(result.html);
  const scrapedAt = new Date().toISOString();
  const updatedText = cleanText($(".last-updated").first().text());
  const updatedMatch = updatedText.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})\s*WIB/);
  let sourceUpdatedAt: string | null = null;
  if (updatedMatch) {
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const [, day, monthName, year, hour, minute] = updatedMatch;
    const monthIndex = months.indexOf(monthName.toLowerCase());
    if (monthIndex !== -1) {
      sourceUpdatedAt = new Date(Date.UTC(Number(year), monthIndex, Number(day), Number(hour) - 7, Number(minute))).toISOString();
    }
  }

  const prices: GoldBuybackPrice[] = [];
  $(".tab-content.harga-kami-beli #perhiasan-emas table tbody tr").each((_, el) => {
    const cells = $(el).find("td");
    if (cells.length < 2) return;
    const { karat, purityPercentage } = parseKaratLabel(cleanText($(cells[0]).text()));
    if (karat === null) return;
    prices.push(makeRow({
      storeId, storeName, karat, purityPercentage,
      buybackPricePerGram: parseRupiah(cleanText($(cells[1]).text())),
      sourceUpdatedAt, scrapedAt,
    }));
  });

  const status = statusFromRows(prices);
  return { storeId, storeName, sourceUrl, status, httpStatus: result.status, error: status === "failed" ? "Tidak ada baris harga yang berhasil dibaca" : null, prices };
}

async function scrapeRajaemas(): Promise<StoreResult> {
  const storeId = "rajaemas";
  const storeName = "Raja Emas Indonesia";
  const sourceUrl = "https://rajaemasindonesia.co.id/";
  // The homepage embeds the karat table as an iframe whose script loads per-region
  // prices from published Google Sheets CSVs; the <select> option index matches the
  // index in its `spreadsheetUrls` array. We use the Sumatera, Bali & Lombok region.
  const widgetUrl = "https://rajaemasindonesia.co.id/wp-content/plugins/rajaemas-live-price-table/preview-demo.html";
  const regionPattern = /sumatera/i;

  const widget = await fetchPage(widgetUrl);
  if (!widget.ok || !widget.html) {
    const message = widget.status === 403 ? "Diblokir oleh proteksi keamanan situs (403)" : widget.error;
    return { storeId, storeName, sourceUrl, status: "failed", httpStatus: widget.status, error: message, prices: [] };
  }

  const $ = cheerio.load(widget.html);
  const regionIndex = $(".rei-region-select option").toArray().findIndex((el) => regionPattern.test($(el).text()));
  const csvUrls = [...widget.html.matchAll(/https:\/\/docs\.google\.com\/spreadsheets\/[^'"\s]+output=csv/g)].map((m) => m[0]);
  const csvUrl = regionIndex === -1 ? undefined : csvUrls[regionIndex];
  if (!csvUrl) {
    return { storeId, storeName, sourceUrl, status: "failed", httpStatus: widget.status, error: "URL data harga wilayah Sumatera, Bali, Lombok tidak ditemukan", prices: [] };
  }

  await sleep(DELAY_BETWEEN_REQUESTS_MS);
  const csv = await fetchPage(csvUrl);
  if (!csv.ok || !csv.html) {
    return { storeId, storeName, sourceUrl, status: "failed", httpStatus: csv.status, error: csv.error ?? "Gagal mengambil data harga", prices: [] };
  }

  const scrapedAt = new Date().toISOString();
  const prices: GoldBuybackPrice[] = [];
  // Rows look like: K24 (99.5%),"Rp 2,124,000" — prices use commas as thousands separators.
  for (const line of csv.html.split(/\r?\n/)) {
    const match = line.match(/^([^,]+),\s*"?([^"]*)"?\s*$/);
    if (!match) continue;
    const { karat, purityPercentage } = parseKaratLabel(cleanText(match[1]));
    if (karat === null) continue;
    const digits = match[2].replace(/\D/g, "");
    prices.push(makeRow({
      storeId, storeName, karat, purityPercentage,
      buybackPricePerGram: digits ? Number(digits) : null,
      sourceUpdatedAt: null, scrapedAt,
    }));
  }

  const status = statusFromRows(prices);
  return { storeId, storeName, sourceUrl, status, httpStatus: csv.status, error: status === "failed" ? "Tidak ada baris harga yang berhasil dibaca" : null, prices };
}

async function scrapeQueenemas(): Promise<StoreResult> {
  const storeId = "queenemas";
  const storeName = "Queen Emas";
  const sourceUrl = "https://queenemas.com/";
  const result = await fetchPage(sourceUrl);
  if (!result.ok || !result.html) {
    return { storeId, storeName, sourceUrl, status: "failed", httpStatus: result.status, error: result.error, prices: [] };
  }

  const $ = cheerio.load(result.html);
  const scrapedAt = new Date().toISOString();
  // The price table no longer shows a date, so there's no source timestamp.
  const sourceUpdatedAt = null;
  // Only karat rows ("24K 99.99", "23K"); bullion (ANTAM, UBS) and silver rows are skipped.
  const karatRowPattern = /^(\d{1,2})K(?:\s+([\d.]+))?$/i;

  const prices: GoldBuybackPrice[] = [];
  $("#goldPriceTable tbody tr").each((_, el) => {
    const cells = $(el).find("td");
    if (cells.length < 2) return;
    const match = cleanText($(cells[0]).text()).match(karatRowPattern);
    if (!match) return;
    const karat = Number(match[1]);
    if (!Number.isInteger(karat) || karat < 1 || karat > 24) return;
    const purityPercentage = match[2] ? Number(match[2]) : percentageFromKarat(karat);
    prices.push(makeRow({
      storeId, storeName, karat, purityPercentage,
      buybackPricePerGram: parseRupiah(cleanText($(cells[1]).text())),
      sourceUpdatedAt, scrapedAt,
    }));
  });

  const status = statusFromRows(prices);
  return { storeId, storeName, sourceUrl, status, httpStatus: result.status, error: status === "failed" ? "Tidak ada baris harga yang berhasil dibaca" : null, prices };
}

async function scrapeGoemas(): Promise<StoreResult> {
  const storeId = "goemas";
  const storeName = "Goemas";
  const sourceUrl = "https://goemas.id/";
  const result = await fetchPage(sourceUrl);
  if (!result.ok || !result.html) {
    return { storeId, storeName, sourceUrl, status: "failed", httpStatus: result.status, error: result.error, prices: [] };
  }

  const $ = cheerio.load(result.html);
  const scrapedAt = new Date().toISOString();
  const sourceUpdatedAt = parseIndonesianDate($("#price_gold .text-primary").first().text());
  // Jewelry buyback rows read "8 K - Jenis Emas Segala Kondisi"; coin/bar products use a
  // different label and are excluded (perhiasan only).
  const jewelryRowPattern = /^(\d{1,2})\s*K\s*-\s*Jenis Emas/i;

  const prices: GoldBuybackPrice[] = [];
  $("#price_gold table tbody tr").each((_, el) => {
    const cells = $(el).find("td");
    if (cells.length < 2) return;
    const match = cleanText($(cells[0]).text()).match(jewelryRowPattern);
    if (!match) return;
    const karat = Number(match[1]);
    if (!Number.isInteger(karat) || karat < 1 || karat > 24) return;
    prices.push(makeRow({
      storeId, storeName, karat, purityPercentage: percentageFromKarat(karat),
      buybackPricePerGram: parseRupiah(cleanText($(cells[1]).text())),
      sourceUpdatedAt, scrapedAt,
    }));
  });

  const status = statusFromRows(prices);
  return { storeId, storeName, sourceUrl, status, httpStatus: result.status, error: status === "failed" ? "Tidak ada baris harga yang berhasil dibaca" : null, prices };
}

async function scrapeBaritogold(): Promise<StoreResult> {
  const storeId = "baritogold";
  const storeName = "Barito Gold";
  const sourceUrl = "https://www.baritogold.com/harga";
  const result = await fetchPage(sourceUrl);
  if (!result.ok || !result.html) {
    return { storeId, storeName, sourceUrl, status: "failed", httpStatus: result.status, error: result.error, prices: [] };
  }

  const $ = cheerio.load(result.html);
  const scrapedAt = new Date().toISOString();
  const optionPattern = /kami-beli-(\d{1,2})k(?:-([\d,]+))?/i;

  const prices: GoldBuybackPrice[] = [];
  $("select#goldType option[data-price]").each((_, el) => {
    const value = $(el).attr("value") ?? "";
    const priceAttr = $(el).attr("data-price");
    const match = value.match(optionPattern);
    if (!match || !priceAttr) return;
    const karat = Number(match[1]);
    const purityPercentage = match[2] ? Number(match[2].replace(",", ".")) : percentageFromKarat(karat);
    const buybackPricePerGram = Number(priceAttr);
    prices.push(makeRow({
      storeId, storeName,
      karat: Number.isFinite(karat) ? karat : null,
      purityPercentage,
      buybackPricePerGram: Number.isFinite(buybackPricePerGram) ? buybackPricePerGram : null,
      // The page only renders "today" via client-side JS, not a real published
      // timestamp, so no sourceUpdatedAt is recorded.
      sourceUpdatedAt: null,
      scrapedAt,
    }));
  });

  const status = statusFromRows(prices);
  return { storeId, storeName, sourceUrl, status, httpStatus: result.status, error: status === "failed" ? "Tidak ada baris harga yang berhasil dibaca" : null, prices };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const SCRAPERS = [scrapeIloveemas, scrapeRajaemas, scrapeQueenemas, scrapeGoemas, scrapeBaritogold];

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const results: StoreResult[] = [];
  for (const scraper of SCRAPERS) {
    const result = await scraper();
    results.push(result);
    console.log(`${result.storeName}: ${result.status} (${result.prices.length} baris)${result.error ? ` — ${result.error}` : ""}`);
    await sleep(DELAY_BETWEEN_REQUESTS_MS);
  }

  const allPrices = results.flatMap((r) => r.prices);
  const validated = z.array(goldBuybackPriceSchema).safeParse(allPrices);
  if (!validated.success) {
    console.error("Data hasil scrape gagal validasi skema, tidak menulis file:", validated.error.message);
    process.exitCode = 1;
    return;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    stores: results.map(({ storeId, storeName, sourceUrl, status, httpStatus, error }) => ({
      storeId, storeName, sourceUrl, status, httpStatus, error,
    })),
    prices: validated.data,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf-8");

  const successCount = results.filter((r) => r.status === "success").length;
  const partialCount = results.filter((r) => r.status === "partial").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  console.log(`\nSelesai: ${successCount} sukses, ${partialCount} sebagian, ${failedCount} gagal (dari ${results.length} toko).`);
  console.log(`Tersimpan di ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Scrape run failed:", err);
  process.exitCode = 1;
});
