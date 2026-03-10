/**
 * 烏薩奇漲停版 — 每日自動更新腳本
 *
 * 流程：
 * 1. 從 TWSE/TPEX API 偵測當日漲停股
 * 2. 爬取上市(TWSE)分點資料（ddddocr CAPTCHA）
 * 3. 爬取上櫃(TPEX)分點資料（Playwright + Edge Turnstile）
 * 4. 生成靜態 HTML（node generate.mjs）
 * 5. Git commit + push（觸發 GitHub Pages 部署）
 *
 * 排程：PM2 cron 每個交易日 15:30 執行
 * 手動：node daily-update.mjs
 */

import { execSync, spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import axios from "axios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROKER_MCP_DIR = path.resolve(__dirname, "../twse-broker-mcp");
const CACHE_DIR = path.join(BROKER_MCP_DIR, "cache");
const HISTORY_FILE = path.join(__dirname, "data", "history.json");
const MAX_HISTORY_DAYS = 240;

// ============================================================
// Helpers
// ============================================================
function log(msg) {
  const ts = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  console.log(`[${ts}] ${msg}`);
}

function isWeekday() {
  const day = new Date().getDay();
  return day >= 1 && day <= 5;
}

function todayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function runCmd(cmd, opts = {}) {
  log(`> ${cmd}`);
  try {
    const out = execSync(cmd, { encoding: "utf-8", timeout: 300000, ...opts });
    return out.trim();
  } catch (e) {
    log(`  ⚠ 指令失敗: ${e.message}`);
    return null;
  }
}

// ============================================================
// Step 1: 偵測漲停股
// ============================================================
async function detectLimitStocks() {
  log("📊 偵測當日漲停股...");

  const twseStocks = [];
  const tpexStocks = [];

  // TWSE 上市
  try {
    const resp = await axios.get("https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json", { timeout: 15000 });
    const json = resp.data;
    const data = (json.data || []).map(r => ({
      code: r[0], name: r[1].replace(/\s+/g, ""),
      close: parseFloat(r[7]), high: parseFloat(r[5]), change: parseFloat(r[8]),
    }));
    for (const s of data) {
      if (!s.close || !s.high || isNaN(s.change)) continue;
      const prev = s.close - s.change;
      if (prev <= 0) continue;
      const pct = (s.change / prev) * 100;
      if (s.close === s.high && pct >= 9.5) {
        twseStocks.push({ ...s, market: "TWSE" });
      }
    }
    log(`  TWSE: ${twseStocks.length} 檔漲停`);
  } catch (e) {
    log(`  ⚠ TWSE API 失敗: ${e.message}`);
  }

  // TPEX 上櫃
  try {
    const resp = await axios.get("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes", {
      responseType: "arraybuffer", timeout: 15000,
    });
    const data = JSON.parse(Buffer.from(resp.data).toString("utf-8"));
    for (const s of data) {
      const close = parseFloat(s.Close);
      const high = parseFloat(s.High);
      const change = parseFloat(s.Change);
      if (!close || !high || isNaN(change)) continue;
      const prev = close - change;
      if (prev <= 0) continue;
      const pct = (change / prev) * 100;
      if (close === high && pct >= 9.5) {
        tpexStocks.push({ code: s.SecuritiesCompanyCode, name: s.CompanyName, close, high, change, market: "TPEX" });
      }
    }
    log(`  TPEX: ${tpexStocks.length} 檔漲停`);
  } catch (e) {
    log(`  ⚠ TPEX API 失敗: ${e.message}`);
  }

  return { twse: twseStocks, tpex: tpexStocks };
}

// ============================================================
// Step 2: 爬 TWSE 分點（上市）
// ============================================================
async function scrapeTwseBrokers(stocks) {
  if (stocks.length === 0) return;
  log(`🔍 爬取 TWSE 分點 (${stocks.length} 檔)...`);

  const date = todayStr();
  const codes = stocks.map(s => s.code);

  // 檢查哪些已有快取
  const needScrape = codes.filter(c => !fs.existsSync(path.join(CACHE_DIR, `${c}_${date}.json`)));
  if (needScrape.length === 0) {
    log("  全部已有快取，跳過");
    return;
  }

  log(`  需要爬取: ${needScrape.join(", ")}`);

  // 用 node -e 呼叫 fetchBrokerData
  const script = `
    const { fetchBrokerData } = await import('./dist/twse.js');
    const stocks = ${JSON.stringify(needScrape)};
    for (const s of stocks) {
      try {
        const r = await fetchBrokerData(s, '${date}', 15, 10);
        console.log(s + ' OK - ' + r.total_brokers + ' brokers');
      } catch(e) {
        console.log(s + ' FAIL: ' + e.message);
      }
    }
  `;

  runCmd(`node --input-type=module -e "${script.replace(/"/g, '\\"').replace(/\n/g, " ")}"`, { cwd: BROKER_MCP_DIR });
}

// ============================================================
// Step 3: 爬 TPEX 分點（上櫃）
// ============================================================
async function scrapeTpexBrokers(stocks) {
  if (stocks.length === 0) return;
  log(`🔍 爬取 TPEX 分點 (${stocks.length} 檔)...`);

  const date = todayStr();
  const codes = stocks.map(s => s.code);

  const needScrape = codes.filter(c => !fs.existsSync(path.join(CACHE_DIR, `${c}_${date}.json`)));
  if (needScrape.length === 0) {
    log("  全部已有快取，跳過");
    return;
  }

  log(`  需要爬取: ${needScrape.join(", ")}`);

  // TPEX 爬蟲需要 Edge 瀏覽器（headless: false）
  runCmd(`node tpex_scraper.mjs ${needScrape.join(" ")}`, { cwd: BROKER_MCP_DIR });
}

// ============================================================
// Step 3.5: 更新歷史紀錄
// ============================================================
function updateHistory(allStocks) {
  log("📚 更新歷史紀錄...");

  // Load existing history
  let history;
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    }
  } catch {}
  if (!history) history = { last_updated: null, days: {} };

  const date = todayStr();

  // Idempotent: skip if today already recorded
  if (history.days[date]) {
    log("  今天已有記錄，跳過");
    return;
  }

  const dayEntry = { stocks: {} };

  for (const stock of allStocks) {
    // Try loading broker cache
    const cacheFile = path.join(CACHE_DIR, `${stock.code}_${date}.json`);
    let brokers = { buy: [], sell: [] };

    if (fs.existsSync(cacheFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
        brokers.buy = (data.top_buyers || []).slice(0, 5).map(b => ({
          id: b.broker_id, name: b.broker_name, net: b.net_volume,
        }));
        brokers.sell = (data.top_sellers || []).slice(0, 5).map(b => ({
          id: b.broker_id, name: b.broker_name, net: b.net_volume,
        }));
      } catch {}
    }

    dayEntry.stocks[stock.code] = {
      name: stock.name,
      close: stock.close,
      change: stock.change,
      changePct: stock.change && stock.close
        ? ((stock.change / (stock.close - stock.change)) * 100).toFixed(2)
        : null,
      volume: null,
      market: stock.market,
      brokers,
    };
  }

  history.days[date] = dayEntry;
  history.last_updated = date;

  // Trim old entries (keep MAX_HISTORY_DAYS)
  const sortedDates = Object.keys(history.days).sort();
  if (sortedDates.length > MAX_HISTORY_DAYS) {
    const toRemove = sortedDates.slice(0, sortedDates.length - MAX_HISTORY_DAYS);
    for (const d of toRemove) delete history.days[d];
    log(`  清理 ${toRemove.length} 天舊記錄`);
  }

  // Write
  const dataDir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

  const stockCount = Object.keys(dayEntry.stocks).length;
  log(`  ✅ 記錄 ${date}: ${stockCount} 檔漲停`);
}

// ============================================================
// Step 4: 生成靜態網站
// ============================================================
function generateSite() {
  log("📝 生成靜態網站...");
  runCmd("node generate.mjs", { cwd: __dirname });
}

// ============================================================
// Step 5: Git push
// ============================================================
function gitPush() {
  log("🚀 推送到 GitHub...");

  const status = runCmd("git status --short", { cwd: __dirname });
  if (!status) {
    log("  沒有變更，跳過");
    return;
  }

  const date = todayStr();
  const formattedDate = `${date.substring(0, 4)}/${date.substring(4, 6)}/${date.substring(6, 8)}`;

  runCmd("git add -A", { cwd: __dirname });

  // 計算漲停股數
  const siteStockDir = path.join(__dirname, "site", "stock");
  let stockCount = 0;
  try {
    stockCount = fs.readdirSync(siteStockDir).filter(f => f.endsWith(".html")).length;
  } catch {}

  const msg = `Update ${formattedDate}: ${stockCount} stocks`;
  runCmd(`git commit -m "${msg}"`, { cwd: __dirname });
  runCmd("git push", { cwd: __dirname });

  log(`  ✅ 已推送: ${msg}`);
}

// ============================================================
// Main
// ============================================================
async function main() {
  log("🐰 烏薩奇漲停版 — 每日自動更新");
  log("=".repeat(50));

  // 假日檢查（可加 --force 強制執行）
  if (!isWeekday() && !process.argv.includes("--force")) {
    log("今天不是交易日，跳過（用 --force 強制執行）");
    process.exit(0);
  }

  try {
    // Step 1: 偵測漲停
    const { twse, tpex } = await detectLimitStocks();
    const total = twse.length + tpex.length;

    if (total === 0) {
      log("❌ 今天沒有漲停股（可能盤後資料還沒出來）");
      process.exit(0);
    }

    log(`📈 共 ${total} 檔漲停（上市 ${twse.length} / 上櫃 ${tpex.length}）`);

    // Step 2 & 3: 爬分點
    await scrapeTwseBrokers(twse);
    await scrapeTpexBrokers(tpex);

    // Step 3.5: 更新歷史紀錄
    updateHistory([...twse, ...tpex]);

    // Step 4: 生成網站
    generateSite();

    // Step 5: 推送
    gitPush();

    log("=".repeat(50));
    log("🎉 每日更新完成！");

  } catch (e) {
    log(`❌ 更新失敗: ${e.message}`);
    console.error(e);
    process.exit(1);
  }
}

main();
