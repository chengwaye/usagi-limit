/**
 * 回填歷史資料 — 從 twse-broker-mcp/cache 讀取已有 JSON 回填 history.json
 * 一次性腳本：node backfill.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, "../twse-broker-mcp/cache");
const HISTORY_FILE = path.join(__dirname, "data", "history.json");

function loadHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8")); } catch {}
  }
  return { last_updated: null, days: {} };
}

function extractBrokerSummary(brokerList, limit = 5) {
  return (brokerList || []).slice(0, limit).map(b => ({
    id: b.broker_id,
    name: b.broker_name,
    net: b.net_volume,
  }));
}

function main() {
  console.log("📦 回填歷史資料...");

  // Scan cache for valid JSON files
  const files = fs.readdirSync(CACHE_DIR)
    .filter(f => /^\d+_\d{8}\.json$/.test(f));

  console.log(`  找到 ${files.length} 個快取檔`);

  const history = loadHistory();
  let added = 0;

  for (const file of files) {
    const match = file.match(/^(\d+)_(\d{8})\.json$/);
    if (!match) continue;

    const [, stockId, date] = match;
    const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), "utf-8"));

    if (!history.days[date]) {
      history.days[date] = { stocks: {} };
    }

    if (history.days[date].stocks[stockId]) continue; // 已有，跳過

    history.days[date].stocks[stockId] = {
      name: null, // cache 沒有股名，generate 時從 API 補
      close: null,
      change: null,
      changePct: null,
      volume: null,
      market: null,
      backfilled: true,
      brokers: {
        buy: extractBrokerSummary(data.top_buyers),
        sell: extractBrokerSummary(data.top_sellers),
      },
    };
    added++;
  }

  // Update last_updated
  const dates = Object.keys(history.days).sort();
  if (dates.length > 0) {
    history.last_updated = dates[dates.length - 1];
  }

  // Ensure data dir exists
  const dataDir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  console.log(`  新增 ${added} 筆記錄`);
  console.log(`  歷史日期: ${dates.join(", ")}`);
  console.log(`  已寫入: ${HISTORY_FILE}`);
}

main();
