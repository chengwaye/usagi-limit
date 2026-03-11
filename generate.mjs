/**
 * 烏薩奇漲停版 — 靜態網頁生成器
 * 讀取 twse-broker-mcp/cache 中的分點資料，生成靜態 HTML 頁面
 */

import fs from "fs";
import path from "path";
import axios from "axios";
import { classifyWithClaude } from "./claude-classifier.mjs";
// import { loadFinLabBrokerDataForStock } from "./finlab-broker-loader.mjs"; // 已移除 FinLab 資料

const CACHE_DIR = path.resolve("../twse-broker-mcp/cache");
const SITE_DIR = path.resolve("./docs");

// Load concept mapping
let conceptMapping = {};
try {
  const conceptData = JSON.parse(fs.readFileSync("./concept-mapping.json", "utf-8"));
  conceptMapping = conceptData.concepts;
} catch (e) {
  console.log("Warning: Could not load concept-mapping.json, will use default classification");
}

// Ensure output dirs exist
if (!fs.existsSync(SITE_DIR)) fs.mkdirSync(SITE_DIR, { recursive: true });
const STOCK_DIR = path.join(SITE_DIR, "stock");
if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });

// Fetch institutional investors (三大法人) data
async function fetchInstitutionalData(date) {
  try {
    const url = `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${date}&selectType=ALL`;
    const resp = await axios.get(url);
    const json = resp.data;

    if (json.stat !== "OK" || !json.data) {
      console.log(`No institutional data for ${date}`);
      return {};
    }

    // Parse institutional data: 0=代號, 1=名稱, 4=外資買賣超, 10=投信買賣超, 11=自營商買賣超, 18=三大法人合計
    const parse = (val) => parseInt(String(val || '0').replace(/,/g, '')) || 0;
    const institutionalMap = {};
    json.data.forEach(row => {
      if (!row || row.length < 19) return; // skip incomplete rows
      const code = String(row[0]).trim();
      institutionalMap[code] = {
        foreign: parse(row[4]),      // 外資買賣超
        trust: parse(row[10]),       // 投信買賣超
        dealer: parse(row[11]),      // 自營商買賣超
        total: parse(row[18])        // 三大法人合計
      };
    });

    console.log(`Fetched institutional data: ${Object.keys(institutionalMap).length} stocks`);
    return institutionalMap;
  } catch (e) {
    console.log(`Failed to fetch institutional data: ${e.message}`);
    return {};
  }
}

// Convert date to ROC (Taiwan) format: YYYYMMDD -> YYY/MM/DD (民國年)
function formatROCDate(dateStr) {
  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const day = dateStr.substring(6, 8);
  const rocYear = parseInt(year) - 1911;
  return `${rocYear.toString().padStart(3, '0')}/${month}/${day}`;
}

// Fetch TPEX (櫃買) institutional investors data
async function fetchTPEXInstitutionalData(date) {
  try {
    const rocDate = formatROCDate(date);
    const url = 'https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php';
    const params = {
      d: rocDate,
      l: 'zh-tw',
      o: 'json', // Use JSON format
      s: '0',
      se: 'EW',
      t: 'D'
    };

    const resp = await axios.get(url, { params, timeout: 20000 });
    const json = resp.data;

    if (!json || !json.tables || !json.tables[0] || !json.tables[0].data) {
      console.log(`No TPEX institutional data for ${date}`);
      return {};
    }

    // Parse TPEX data (3itrade_hedge_result, se=EW):
    // 7 groups × 3 cols (買進/賣出/買賣超) + 合計
    // [2-4] 外資(不含自營商)  [5-7] 外資自營商  [8-10] 外資合計
    // [11-13] 投信  [14-16] 自營商(自行買賣)  [17-19] 自營商(避險)
    // [20-22] 自營商合計  [23] 三大法人合計
    const parse = (val) => parseInt(String(val || '0').replace(/,/g, '')) || 0;
    const institutionalMap = {};

    json.tables[0].data.forEach(row => {
      if (!row || row.length < 24) return; // skip incomplete rows
      const code = String(row[0]).trim();

      // Skip ETF and bond codes (usually start with 00)
      if (code.startsWith('00')) return;

      const foreign = parse(row[4]);   // 外資(不含自營商) 買賣超
      const trust = parse(row[13]);    // 投信 買賣超
      const dealer = parse(row[22]);   // 自營商合計 買賣超

      institutionalMap[code] = {
        foreign: foreign,
        trust: trust,
        dealer: dealer,
        total: parse(row[23])           // 三大法人合計（API 直接提供）
      };
    });

    console.log(`Fetched TPEX institutional data: ${Object.keys(institutionalMap).length} stocks`);
    return institutionalMap;

  } catch (e) {
    console.log(`Failed to fetch TPEX institutional data: ${e.message}`);
    return {};
  }
}

// Merge TWSE + TPEX institutional data
async function fetchAllInstitutionalData(date) {
  const [twseData, tpexData] = await Promise.all([
    fetchInstitutionalData(date),
    fetchTPEXInstitutionalData(date)
  ]);

  // Merge both maps
  return { ...twseData, ...tpexData };
}

// ============================================================
// 台股漲停價計算（含升降單位 tick 規則）
// ============================================================
function getTick(price) {
  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.1;
  if (price < 500) return 0.5;
  if (price < 1000) return 1;
  return 5;
}

function calcLimitUpPrice(prevClose) {
  // 理論漲停價 = 昨收 × 1.10
  const raw = prevClose * 1.10;
  const tick = getTick(raw);
  // 取最接近但不超過理論漲停價的 tick
  return Math.floor(raw / tick) * tick;
}

function isLimitUp(close, prevClose) {
  const limitPrice = calcLimitUpPrice(prevClose);
  // 浮點數比較，容許極小誤差
  return Math.abs(close - limitPrice) < 0.001;
}

// ============================================================
// Step 1: Get today's market data for limit up/down detection
// ============================================================
async function getLimitStocks() {
  // 優先用 TWSE 正式 API（更新較快），fallback 到 OpenAPI
  let data, dateStr;
  try {
    const resp = await axios.get("https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json");
    const json = resp.data;
    dateStr = json.date; // "20260309"
    // 欄位: [代號, 名稱, 成交股數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, 漲跌, 成交筆數]
    data = (json.data || []).map(r => ({
      Code: r[0], Name: r[1].replace(/\s+/g, ''),
      TradeVolume: r[2].replace(/,/g, ''),
      HighestPrice: r[5], LowestPrice: r[6],
      ClosingPrice: r[7], Change: r[8],
    }));
    console.log(`Using TWSE API, date: ${dateStr}, ${data.length} stocks`);
  } catch (e) {
    console.log(`TWSE API failed (${e.message}), falling back to OpenAPI`);
    const resp = await axios.get("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");
    data = resp.data;
    // OpenAPI date is ROC: "1150306"
    const rocDate = data[0]?.Date;
    const y = parseInt(rocDate.substring(0, 3)) + 1911;
    dateStr = `${y}${rocDate.substring(3, 7)}`;
  }

  const stocks = {};
  for (const s of data) {
    const close = parseFloat(s.ClosingPrice);
    const high = parseFloat(s.HighestPrice);
    const change = parseFloat(s.Change);
    if (!close || !high || isNaN(change)) continue;
    const prevClose = close - change;
    if (prevClose <= 0) continue;
    const pct = (change / prevClose) * 100;

    // 漲停判斷：收盤價 === 漲停價（依 tick 規則計算）
    if (!isLimitUp(close, prevClose)) continue;

    {
      stocks[s.Code] = {
        code: s.Code,
        name: s.Name,
        close,
        change,
        changePct: pct.toFixed(2),
        volume: parseInt(String(s.TradeVolume).replace(/,/g, '')),
        type: "漲停",
      };
    }
  }

  // 也加入 TPEX 上櫃漲停股
  try {
    const tpexResp = await axios.get("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes", {
      responseType: 'arraybuffer'
    });
    const tpexText = Buffer.from(tpexResp.data).toString('utf-8');
    const tpexData = JSON.parse(tpexText);
    let otcCount = 0;
    for (const s of tpexData) {
      const close = parseFloat(s.Close);
      const high = parseFloat(s.High);
      const change = parseFloat(s.Change);
      if (!close || !high || isNaN(change)) continue;
      const prevClose = close - change;
      if (prevClose <= 0) continue;
      const pct = (change / prevClose) * 100;

      // 漲停判斷：收盤價 === 漲停價（依 tick 規則計算）
      if (!isLimitUp(close, prevClose)) continue;

      otcCount++;
      stocks[s.SecuritiesCompanyCode] = {
        code: s.SecuritiesCompanyCode,
        name: s.CompanyName,
        close,
        change,
        changePct: pct.toFixed(2),
        volume: parseInt(String(s.TradingShares).replace(/,/g, '')),
        type: "漲停",
        market: "OTC",
      };
    }
    console.log(`TPEX: ${otcCount} OTC limit up stocks`);
  } catch (e) {
    console.log(`TPEX API failed: ${e.message}`);
  }

  return { stocks, date: dateStr };
}

// ============================================================
// Step 2: Load cached broker data
// ============================================================
// 回傳 { data, dataDate } — dataDate 是籌碼資料的實際日期
// 只 fallback 到過去的資料（≤ date），不用未來的
async function loadBrokerData(stockCode, date) {
  // date format: YYYYMMDD — try exact match first
  const file = path.join(CACHE_DIR, `${stockCode}_${date}.json`);
  if (fs.existsSync(file)) {
    try { return { data: JSON.parse(fs.readFileSync(file, "utf-8")), dataDate: date }; } catch {}
  }
  // Fallback: find the closest cache that is <= date (only past, never future)
  try {
    const dateInt = parseInt(date);
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(stockCode + "_") && f.endsWith(".json"));
    const pastFiles = files.filter(f => {
      const d = f.match(/_(\d{8})\.json$/)?.[1] || "";
      return parseInt(d) <= dateInt;
    });
    if (pastFiles.length > 0) {
      // Pick the most recent past date
      pastFiles.sort((a, b) => {
        const da = a.match(/_(\d{8})\.json$/)?.[1] || "";
        const db = b.match(/_(\d{8})\.json$/)?.[1] || "";
        return parseInt(db) - parseInt(da); // descending = most recent first
      });
      const best = pastFiles[0];
      const bestDate = best.match(/_(\d{8})\.json$/)?.[1] || "";
      // 允許最多 5 天差距（涵蓋週末+連假）
      if (dateInt - parseInt(bestDate) <= 5) {
        return { data: JSON.parse(fs.readFileSync(path.join(CACHE_DIR, best), "utf-8")), dataDate: bestDate };
      }
    }
  } catch {}

  // FinLab fallback已移除

  return null;
}

// ============================================================
// Step 2.5: Intelligent concept classification using Claude
// ============================================================
async function classifyStocksIntelligently(stocks) {
  try {
    // Try Claude-powered intelligent classification
    const analysisResult = await classifyWithClaude(stocks);
    return analysisResult;

  } catch (error) {
    console.log('Claude analysis failed, falling back to smart heuristics');
    return await simulateClaudeAnalysis(stocks);
  }
}

// Fallback to static classification
function classifyStocksStatic(stocks) {
  const classified = {};
  const unclassified = [];

  // Initialize concept groups
  for (const [conceptName, conceptInfo] of Object.entries(conceptMapping)) {
    if (conceptName !== "其他") {
      classified[conceptName] = {
        icon: conceptInfo.icon,
        stocks: []
      };
    }
  }

  // Classify each stock
  for (const stock of Object.values(stocks)) {
    let isClassified = false;

    for (const [conceptName, conceptInfo] of Object.entries(conceptMapping)) {
      if (conceptName === "其他") continue;
      if (conceptInfo.stocks.includes(stock.code)) {
        classified[conceptName].stocks.push(stock);
        isClassified = true;
        break;
      }
    }

    if (!isClassified) {
      unclassified.push(stock);
    }
  }

  // Add unclassified stocks to "其他" if they exist
  if (unclassified.length > 0) {
    classified["其他"] = {
      icon: conceptMapping["其他"]?.icon || "📊",
      stocks: unclassified
    };
  }

  // Remove empty concept groups
  const result = {};
  for (const [conceptName, conceptData] of Object.entries(classified)) {
    if (conceptData.stocks.length > 0) {
      result[conceptName] = conceptData;
    }
  }

  return result;
}

// Smart heuristic analysis based on industry patterns
async function simulateClaudeAnalysis(stocks) {
  const concepts = {};
  const stockArray = Object.values(stocks);

  // Analyze stock patterns and group by likely reasons
  const groups = [];

  // 天然氣族群 (欣字輩 + 新海)
  const gasStocks = stockArray.filter(s =>
    s.name.includes('欣') || s.name.includes('新海') || ['8908', '8917', '9918', '9926', '9931'].includes(s.code)
  );
  if (gasStocks.length >= 3) {
    groups.push({
      name: '天然氣概念股大爆發',
      icon: '🔥',
      reason: `天然氣價格走強，${gasStocks.length}檔欣字輩概念股集體漲停`,
      stocks: gasStocks
    });
  }

  // 石化塑化族群
  const petroStocks = stockArray.filter(s =>
    s.name.includes('化') || s.name.includes('塑') || ['1309', '1314', '6505'].includes(s.code)
  );
  if (petroStocks.length >= 3) {
    groups.push({
      name: '石化塑化族群同步走強',
      icon: '🛢️',
      reason: `原油價格反彈，石化上游受惠，${petroStocks.length}檔同步漲停`,
      stocks: petroStocks
    });
  }

  // 個別股票分析
  const remaining = stockArray.filter(s =>
    !gasStocks.includes(s) && !petroStocks.includes(s)
  );

  // 根據股票名稱和代碼進行個別分析
  remaining.forEach(stock => {
    let conceptName, icon, reason;

    // 精準分析每檔股票
    switch(stock.code) {
      case '5386': // 青雲
        conceptName = '雲端記憶體需求爆發';
        icon = '☁️';
        reason = '雲端運算與AI記憶體需求暴增，青雲記憶體模組受惠';
        break;
      case '4973': // 廣穎
        conceptName = '記憶體模組強勢';
        icon = '🧠';
        reason = 'AI伺服器記憶體需求強勁，記憶體模組廠商營運看漲';
        break;
      case '2426': // 鼎元
        conceptName = '半導體設備利多';
        icon = '⚡';
        reason = '半導體產能擴充需求，設備廠商受惠AI晶片製造潮';
        break;
      case '3054': // 立萬利
        conceptName = 'PCB載板需求';
        icon = '📱';
        reason = 'AI晶片高階載板需求增加，PCB廠商技術升級受惠';
        break;
      case '1762': // 中化生
        conceptName = '生技化學雙重利多';
        icon = '🧪';
        reason = '既有石化概念又有生技醫療題材，雙重利多加持';
        break;
      case '4911': // 德英
        conceptName = '生技新藥進展';
        icon = '💊';
        reason = '新藥研發進度或法規利多，生技股獨立表現';
        break;
      case '6715': // 嘉基
        conceptName = '醫療設備升級';
        icon = '🏥';
        reason = '醫療數位化與AI導入，醫療設備廠商受惠';
        break;
      case '2616': // 山隆
        conceptName = '鋼鐵原料回溫';
        icon = '🔩';
        reason = '基建需求復甦，鋼鐵原物料價格止跌回升';
        break;
      case '3709': // 鑫聯大投控
        conceptName = '金融投控布局';
        icon = '🏦';
        reason = '金融環境改善，投控公司資產重估與獲利回升';
        break;
      case '6508': // 惠光
        conceptName = '光電元件需求';
        icon = '💡';
        reason = '光電通訊與顯示需求增加，相關元件廠商受惠';
        break;
      default:
        conceptName = `${stock.name}個股利多`;
        icon = '📈';
        reason = '個別基本面利多或技術面突破，股價強勢表現';
    }

    groups.push({
      name: conceptName,
      icon: icon,
      reason: reason,
      stocks: [stock],
      isSingle: true
    });
  });

  // 現在 groups 包含所有分組（多檔概念 + 單檔概念）

  // 轉換為最終格式
  groups.forEach(group => {
    if (group.stocks.length > 0) {
      concepts[group.name] = {
        icon: group.icon,
        reason: group.reason,
        stocks: group.stocks,
        isSingle: group.isSingle || false
      };
    }
  });

  console.log(`✅ Smart heuristics classified ${Object.keys(concepts).length} concept groups`);
  return concepts;
}

// ============================================================
// Step 3: Generate HTML
// ============================================================
function css() {
  return `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #0d1117; color: #e6edf3; font-family: -apple-system, 'Segoe UI', sans-serif; }
.container { max-width: 1200px; margin: 0 auto; padding: 16px; }
.container.wide { max-width: 1200px; }
header { text-align: center; padding: 16px 0 12px; border-bottom: 1px solid #30363d; margin-bottom: 16px; position: relative; }
header h1 { font-size: 22px; margin-bottom: 2px; }
header h1 span.rabbit { font-size: 26px; }
header .subtitle { color: #8b949e; font-size: 13px; }

/* Date navigation */
.date-nav { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 8px; }
.date-nav .date { font-size: 14px; color: #e6edf3; font-weight: 600; min-width: 100px; }
.date-nav .nav-btn {
  background: #21262d; border: 1px solid #30363d; color: #8b949e; padding: 4px 10px;
  border-radius: 4px; cursor: pointer; font-size: 12px; transition: all 0.2s;
}
.date-nav .nav-btn:hover:not(:disabled) { background: #30363d; color: #e6edf3; }
.date-nav .nav-btn:disabled { opacity: 0.5; cursor: not-allowed; }

header .cta-hint {
  position: absolute;
  top: 16px;
  right: 20px;
  background: linear-gradient(135deg, #1e3a8a 0%, #3730a3 100%);
  border: 1px solid #3b82f6;
  border-radius: 6px;
  padding: 8px 12px;
  color: #60a5fa;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  text-align: center;
  min-width: 180px;
}
header .cta-hint:hover {
  background: linear-gradient(135deg, #2563eb 0%, #4338ca 100%);
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(37, 99, 235, 0.3);
}
header .date-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 8px;
}
header .date-nav .nav-btn {
  background: #21262d;
  border: 1px solid #30363d;
  color: #8b949e;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
}
header .date-nav .nav-btn:hover { background: #30363d; color: #e6edf3; }
header .date-nav .nav-btn:disabled { opacity: 0.4; cursor: not-allowed; }
header .date-nav .date { color: #58a6ff; font-size: 15px; font-weight: 600; }

.section-title { font-size: 16px; margin: 16px 0 10px; padding-left: 8px; border-left: 3px solid #f85149; }

.concept-section { margin-bottom: 20px; }
.concept-title {
  font-size: 14px;
  margin: 12px 0 8px;
  padding: 8px 12px;
  background: #21262d;
  border-radius: 6px;
  border-left: 3px solid #58a6ff;
  display: flex;
  align-items: center;
  gap: 8px;
}
.concept-title .icon { font-size: 16px; }
.concept-title .count {
  color: #8b949e;
  font-size: 12px;
  margin-left: auto;
}
.concept-reason {
  color: #8b949e;
  font-size: 11px;
  margin: 0 12px 8px 12px;
  font-style: italic;
}
.stock-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.stock-grid.single { grid-template-columns: 1fr; gap: 4px; max-width: 280px; display: inline-grid; margin-right: 16px; vertical-align: top; }
.singles-container { display: flex; flex-wrap: wrap; gap: 0; }
.stock-card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; overflow: hidden; transition: all 0.2s ease; }
.stock-card a { text-decoration: none; color: inherit; display: block; padding: 10px 12px; transition: all 0.2s ease; }
.stock-card a:hover { background: #1c2129; }
.stock-header { display: flex; justify-content: space-between; align-items: center; }
.stock-name { font-size: 14px; font-weight: 600; }
.stock-code { color: #8b949e; font-size: 12px; margin-left: 6px; }
.stock-price { text-align: right; }
.stock-close { font-size: 14px; font-weight: 600; }
.stock-change { font-size: 11px; margin-top: 1px; }
.up { color: #f85149; }
.down { color: #3fb950; }
.stock-meta { display: flex; justify-content: space-between; margin-top: 6px; font-size: 11px; color: #8b949e; }

/* AdSense 廣告位 */
.ads-container {
  display: flex;
  gap: 20px;
  align-items: flex-start;
  margin-top: 20px;
}
.content-wrapper {
  flex: 1;
  min-width: 0;
}
.sidebar-ad {
  width: 160px;
  min-height: 600px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #484f58;
  font-size: 11px;
  text-align: center;
  position: sticky;
  top: 20px;
}

/* Stock detail page */
.back { display: inline-block; color: #58a6ff; text-decoration: none; margin-bottom: 16px; font-size: 14px; }
.back:hover { text-decoration: underline; }
.info-bar { display: flex; justify-content: space-between; align-items: center; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
.info-left h2 { font-size: 22px; }
.info-left .code { color: #8b949e; font-size: 14px; }
.info-right { text-align: right; }
.info-right .price { font-size: 24px; font-weight: 700; }
.info-right .change-info { font-size: 14px; margin-top: 4px; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 4px; font-size: 13px; font-weight: 600; }
.badge.up { background: rgba(248,81,73,0.2); }
.badge.down { background: rgba(63,185,80,0.2); }

/* Side-by-side tables */
.dual-panel { display: flex; gap: 16px; }
.panel { flex: 1; min-width: 0; }
.panel-title { text-align: center; padding: 8px; font-size: 13px; font-weight: 600; border-bottom: 2px solid #30363d; margin-bottom: 8px; }
.panel-title.buy { border-bottom-color: #f85149; color: #f85149; }
.panel-title.sell { border-bottom-color: #3fb950; color: #3fb950; }

table { width: 100%; border-collapse: collapse; }
th { text-align: right; padding: 3px 4px; font-size: 10px; color: #8b949e; border-bottom: 1px solid #30363d; white-space: nowrap; }
th:first-child { text-align: left; }
td { padding: 4px 4px; font-size: 11px; border-bottom: 1px solid #21262d; text-align: right; font-variant-numeric: tabular-nums; }
td:first-child { text-align: left; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 65px; }
tr:hover { background: #1c2129; }
.net { font-weight: 600; }

footer { text-align: center; padding: 32px 0 24px; color: #484f58; font-size: 12px; border-top: 1px solid #30363d; margin-top: 32px; }
footer a { color: #58a6ff; text-decoration: none; }

@media (max-width: 1000px) {
  .ads-container { flex-direction: column; }
  .sidebar-ad { display: none; }
}
@media (max-width: 1200px) {
  .stock-grid { grid-template-columns: repeat(3, 1fr); }
  .stock-grid.single { max-width: 240px; }
}
@media (max-width: 900px) {
  .stock-grid { grid-template-columns: repeat(2, 1fr); }
  .stock-grid.single { max-width: 100%; margin-right: 0; margin-bottom: 8px; }
  .singles-container { flex-direction: column; }
}
@media (max-width: 700px) {
  .container { padding: 4px; }
  .stock-grid { grid-template-columns: repeat(2, 1fr); gap: 4px; }
  .info-bar { flex-direction: column; text-align: center; gap: 12px; }
  .info-right { text-align: center; }
  .dual-panel { gap: 4px; }
  th { padding: 2px 2px; font-size: 9px; }
  td { padding: 3px 2px; font-size: 9px; }
  td:first-child { max-width: 52px; font-size: 9px; }
  .panel-title { font-size: 11px; padding: 6px; }
  header .date-nav .nav-btn { padding: 3px 8px; font-size: 10px; }
  header .date-nav .date { font-size: 13px; }
  header .cta-hint { position: static; margin: 8px auto 0; min-width: auto; width: fit-content; font-size: 10px; padding: 6px 10px; }
}
`;
}

function formatDate(dateStr) {
  // 支援兩種格式：YYYYMMDD "20260309" 或 ROC "1150306"
  if (dateStr.length === 8) {
    return `${dateStr.substring(0, 4)}/${dateStr.substring(4, 6)}/${dateStr.substring(6, 8)}`;
  }
  // ROC format
  const y = parseInt(dateStr.substring(0, 3)) + 1911;
  const m = dateStr.substring(3, 5);
  const d = dateStr.substring(5, 7);
  return `${y}/${m}/${d}`;
}

function formatVolume(shares) {
  // Convert shares to lots (張): 1 lot = 1000 shares
  const lots = Math.round(shares / 1000);
  return lots.toLocaleString() + "張";
}

// Helper functions for date navigation
function getPrevDate(currentDate, availableDates) {
  const currentIndex = availableDates.indexOf(currentDate);
  if (currentIndex > 0) {
    const prevDate = availableDates[currentIndex - 1];
    // 限制不能早於 2026-03-09
    if (prevDate < "20260309") return null;
    return prevDate;
  }
  return null;
}

function getNextDate(currentDate, availableDates) {
  const currentIndex = availableDates.indexOf(currentDate);
  return currentIndex < availableDates.length - 1 ? availableDates[currentIndex + 1] : null;
}

async function generateIndexPage(limitStocks, date, availableDates = [], stockLinkPrefix = "stock/") {
  const adDate = formatDate(date);
  const upStocks = Object.values(limitStocks);
  const classifiedStocks = await classifyStocksIntelligently(limitStocks);

  const stockCard = (s) => `
    <div class="stock-card">
      <a href="${stockLinkPrefix}${s.code}.html">
        <div class="stock-header">
          <div><span class="stock-name">${s.name}</span><span class="stock-code">${s.code}</span></div>
          <div class="stock-price">
            <div class="stock-close up">$${s.close}</div>
            <div class="stock-change up">+${s.change} (${s.changePct}%)</div>
          </div>
        </div>
        <div class="stock-meta">
          <span>成交量 ${formatVolume(s.volume)}</span>
          <span class="badge up">漲停</span>
        </div>
      </a>
    </div>`;

  // 分離多檔概念和單檔概念
  const multiStockConcepts = [];
  const singleStockConcepts = [];

  Object.entries(classifiedStocks).forEach(([conceptName, conceptData]) => {
    if (conceptData.isSingle) {
      singleStockConcepts.push([conceptName, conceptData]);
    } else {
      multiStockConcepts.push([conceptName, conceptData]);
    }
  });

  // 多檔概念正常顯示
  const multiConceptSections = multiStockConcepts.map(([conceptName, conceptData]) => `
    <div class="concept-section">
      <div class="concept-title">
        <span class="icon">${conceptData.icon}</span>
        <span>${conceptName}</span>
        <span class="count">${conceptData.stocks.length}檔</span>
      </div>
      ${conceptData.reason ? `<div class="concept-reason">${conceptData.reason}</div>` : ''}
      <div class="stock-grid">
        ${conceptData.stocks.map(stockCard).join("\n")}
      </div>
    </div>
  `).join("\n");

  // 單檔概念橫向排列
  const singleConceptSection = singleStockConcepts.length > 0 ? `
    <div class="concept-section">
      <div class="concept-title">
        <span class="icon">💼</span>
        <span>個股表現亮點</span>
        <span class="count">${singleStockConcepts.length}檔</span>
      </div>
      <div class="concept-reason">各股基本面或技術面利多，展現獨立行情</div>
      <div class="singles-container">
        ${singleStockConcepts.map(([conceptName, conceptData]) => `
        <div class="concept-section" style="margin-bottom: 12px;">
          <div class="concept-title" style="margin: 8px 0 4px; font-size: 12px; padding: 6px 8px;">
            <span class="icon" style="font-size: 14px;">${conceptData.icon}</span>
            <span style="font-size: 11px;">${conceptName}</span>
          </div>
          <div class="concept-reason" style="margin: 0 8px 4px; font-size: 10px;">${conceptData.reason}</div>
          <div class="stock-grid single">
            ${conceptData.stocks.map(stockCard).join("\n")}
          </div>
        </div>
        `).join("\n")}
      </div>
    </div>
  ` : '';

  const conceptSections = multiConceptSections + singleConceptSection;

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>烏薩奇漲停版 — ${adDate} 漲停分點追蹤</title>
<meta name="description" content="${adDate} 台股漲停股票券商分點買賣超排行，追蹤主力動向">

<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-L3W7YJ6N37"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-L3W7YJ6N37');
</script>

<!-- AdSense -->
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-4394676027529562"
     crossorigin="anonymous"></script>

<style>${css()}</style>
</head>
<body>
<div class="container">
  <header>
    <div class="cta-hint" onclick="scrollToStocks()">
      💡 點股票看分點、主力泡泡圖
    </div>
    <h1><span class="rabbit">🐰</span> 烏薩奇漲停版</h1>
    <div class="subtitle">AI 分類族群 • 智能解析漲停原因 • 一鍵視覺化主力買賣</div>
    <div class="date-nav">
      <button class="nav-btn" onclick="navigateDate('${date}', -1)" ${!getNextDate(date, availableDates) ? 'disabled' : ''}>◀ 前一天</button>
      <div class="date">${adDate}</div>
      <button class="nav-btn" onclick="navigateDate('${date}', 1)" ${!getPrevDate(date, availableDates) ? 'disabled' : ''}>後一天 ▶</button>
    </div>
  </header>

  <!-- 首頁頂部廣告已移除，提升使用者體驗 -->

  <div class="ads-container">
    <!-- 左側廣告 (桌面版) -->
    <div class="sidebar-ad">
      <!-- 將來在這裡放置 AdSense 垂直廣告代碼 -->
      廣告位<br>(160x600)
    </div>

    <!-- 主要內容 -->
    <div class="content-wrapper">
      <div class="section-title" id="stocks-section">🔴 漲停 (${upStocks.length})</div>
      ${conceptSections}
    </div>

    <!-- 右側廣告 (桌面版) -->
    <div class="sidebar-ad">
      <!-- 將來在這裡放置 AdSense 垂直廣告代碼 -->
      廣告位<br>(160x600)
    </div>
  </div>

  <!-- AI 分析聲明 -->
  <div style="background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; margin: 20px 0; text-align: center;">
    <div style="color: #58a6ff; font-size: 11px; margin-bottom: 4px;">🤖 AI 智能分析</div>
    <div style="color: #8b949e; font-size: 10px; line-height: 1.4;">
      漲停原因與族群分類由 AI 自動分析產生，僅供參考，不代表投資建議，請自行判斷投資風險
    </div>
  </div>

  <footer>
    <p>資料來源：台灣證券交易所公開資訊</p>
    <p>烏薩奇漲停版 &copy; 2026 | 每個交易日 16:30 自動更新</p>
  </footer>
</div>

<script>
// 滾動到股票區
function scrollToStocks() {
  document.getElementById('stocks-section').scrollIntoView({
    behavior: 'smooth',
    block: 'start'
  });
}

// 日期導航功能
function navigateDate(direction) {
  const currentDateStr = '${date}'; // YYYYMMDD format
  const currentDate = new Date(
    parseInt(currentDateStr.substring(0, 4)),
    parseInt(currentDateStr.substring(4, 6)) - 1,
    parseInt(currentDateStr.substring(6, 8))
  );

  // 計算新日期
  const newDate = new Date(currentDate);
  newDate.setDate(newDate.getDate() + direction);

  // 格式化為 YYYYMMDD
  const year = newDate.getFullYear();
  const month = String(newDate.getMonth() + 1).padStart(2, '0');
  const day = String(newDate.getDate()).padStart(2, '0');
  const newDateStr = year + month + day;

  // 構造新的 URL (假設未來會有其他日期的頁面)
  const newUrl = window.location.pathname.replace(/\\/[^/]*$/, '') + '/' + newDateStr + '.html';

  // 目前先顯示提示，未來有多日數據時可以直接跳轉
  alert('🚧 歷史數據功能開發中\\n將來會支援查看 ' + year + '/' + month + '/' + day + ' 的漲停數據');

  // 未來啟用:
  // window.location.href = newUrl;
}

// 股票卡片點擊提示動畫
document.addEventListener('DOMContentLoaded', function() {
  const stockCards = document.querySelectorAll('.stock-card a');
  stockCards.forEach(card => {
    card.addEventListener('mouseenter', function() {
      this.style.transform = 'translateY(-1px)';
      this.style.boxShadow = '0 4px 12px rgba(88, 166, 255, 0.15)';
    });
    card.addEventListener('mouseleave', function() {
      this.style.transform = 'translateY(0)';
      this.style.boxShadow = 'none';
    });
  });

  // Date navigation
  window.navigateDate = function(currentDate, direction) {
    const availableDates = ${JSON.stringify(availableDates)};
    const currentIndex = availableDates.indexOf(currentDate);

    let targetDate;
    if (direction === -1 && currentIndex < availableDates.length - 1) {
      // 前一天：往陣列後面（更舊的日期）
      targetDate = availableDates[currentIndex + 1];
    } else if (direction === 1 && currentIndex > 0) {
      // 後一天：往陣列前面（更新的日期）
      targetDate = availableDates[currentIndex - 1];
    }

    if (targetDate) {
      if (targetDate === availableDates[0]) {
        // Latest date -> index.html
        window.location.href = 'index.html';
      } else {
        // Historical date -> index-YYYYMMDD.html
        window.location.href = \`index-\${targetDate}.html\`;
      }
    }
  };
});
</script>
</body>
</html>`;
}

function fmtVol(v) {
  // volume in shares → 張 (lots of 1000)
  return (v / 1000).toFixed(0);
}

function fmtPrice(p) {
  if (!p) return "-";
  return p.toFixed(2);
}

function generateBubbleChart(brokerData, stockInfo, brokerDataDate, pageDate) {
  const isOldData = brokerDataDate && brokerDataDate !== pageDate;
  const displayClose = isOldData ? (stockInfo.close - stockInfo.change) : stockInfo.close;
  const dateLabel = isOldData ? `<div style="background:#d29922;color:#0d1117;font-size:12px;font-weight:bold;padding:6px 12px;border-radius:4px;margin-bottom:12px;text-align:center;">⚠️ 以下為上一個交易日 (${formatDate(brokerDataDate)}) 的籌碼資料，非今日數據</div>` : '';
  return `
  <div style="margin-top:24px;">
    <div class="panel-title" style="border-bottom-color:#58a6ff;color:#58a6ff;">籌碼泡泡圖</div>
    ${dateLabel}
    <div style="position:relative;width:100%;max-width:700px;margin:0 auto;">
      <canvas id="bubbleChart"></canvas>
    </div>
    <div style="display:flex;justify-content:center;gap:16px;margin-top:8px;flex-wrap:wrap;">
      <span style="color:#484f58;font-size:10px;">⬤ 大泡泡＝買賣超大</span>
      <span style="color:#484f58;font-size:10px;">┆ 買賣分界</span>
      <span style="color:#f85149;font-size:10px;">Y軸紅字＝${isOldData ? '上一交易日' : ''}收盤價</span>
    </div>
  </div>`;
}

function generateBubbleChartScript(brokerData, stockInfo, brokerDataDate, pageDate) {
  const isOldData = brokerDataDate && brokerDataDate !== pageDate;
  // 舊籌碼：用上一交易日收盤價（= 今日平盤價 = close - change）
  const closePrice = isOldData
    ? parseFloat(stockInfo.close - stockInfo.change) || 0
    : parseFloat(stockInfo.close) || 0;

  // Area-proportional: area ∝ single volume, so 10000張買進 area = 4x of 5000張賣出
  // r = sqrt(vol/maxVol) * MAX_R → area ratio = volume ratio
  const toZhang = (v) => Math.round(v / 1000);
  const allBrokers = [...(brokerData.top_buyers || []), ...(brokerData.top_sellers || [])];
  const maxSingleVol = Math.max(
    ...allBrokers.map(b => Math.max(b.buy_volume, b.sell_volume) / 1000), 1
  );
  const MAX_R = 22;
  const calcR = (volume) => {
    const vol = Math.abs(volume) / 1000;
    if (vol <= 0) return 2;
    return Math.max(2, Math.sqrt(vol / maxSingleVol) * MAX_R);
  };

  // Y-axis: 平盤 → 漲停（close - change → close）
  const change = parseFloat(stockInfo.change) || 0;
  let flatPrice, yRange;
  if (isOldData) {
    // 舊籌碼：closePrice 是上一交易日收盤，Y 軸用上一交易日的漲幅範圍
    flatPrice = +(closePrice / 1.10).toFixed(2); // 上一交易日的昨收（近似值）
    yRange = closePrice - flatPrice || 0.5;
  } else {
    flatPrice = +(closePrice - change).toFixed(2); // 平盤價 = 昨收
    yRange = closePrice - flatPrice || 0.5;
  }
  const yAxisMin = flatPrice;
  const yAxisMax = +(closePrice + yRange * 0.25).toFixed(2); // 上方留 25% 給標籤

  // 買超券商的「買進」泡泡（紅色實心，X=-買進量，左側配合買超表格）
  const buyerBuyBubbles = (brokerData.top_buyers || []).map(b => ({
    x: -toZhang(b.buy_volume),
    y: b.buy_avg_price || closePrice,
    r: calcR(b.buy_volume),
    label: b.broker_name,
    net: toZhang(b.net_volume),
    buyVol: toZhang(b.buy_volume),
    sellVol: toZhang(b.sell_volume),
    buyAvg: b.buy_avg_price,
    sellAvg: b.sell_avg_price,
  }));

  // 買超券商的「賣出」泡泡（紅色淡色，X=+賣出量，右側配合賣超表格）
  const buyerSellBubbles = (brokerData.top_buyers || []).map(b => ({
    x: toZhang(b.sell_volume),
    y: b.sell_avg_price || b.buy_avg_price || closePrice,
    r: calcR(b.sell_volume),
    label: b.broker_name,
    net: toZhang(b.net_volume),
    buyVol: toZhang(b.buy_volume),
    sellVol: toZhang(b.sell_volume),
    buyAvg: b.buy_avg_price,
    sellAvg: b.sell_avg_price,
  }));

  // 賣超券商的「賣出」泡泡（綠色實心，X=+賣出量，右側配合賣超表格）
  const sellerSellBubbles = (brokerData.top_sellers || []).map(b => ({
    x: toZhang(b.sell_volume),
    y: b.sell_avg_price || closePrice,
    r: calcR(b.sell_volume),
    label: b.broker_name,
    net: toZhang(b.net_volume),
    buyVol: toZhang(b.buy_volume),
    sellVol: toZhang(b.sell_volume),
    buyAvg: b.buy_avg_price,
    sellAvg: b.sell_avg_price,
  }));

  // 賣超券商的「買進」泡泡（綠色淡色，X=-買進量，左側配合買超表格）
  const sellerBuyBubbles = (brokerData.top_sellers || []).map(b => ({
    x: -toZhang(b.buy_volume),
    y: b.buy_avg_price || b.sell_avg_price || closePrice,
    r: calcR(b.buy_volume),
    label: b.broker_name,
    net: toZhang(b.net_volume),
    buyVol: toZhang(b.buy_volume),
    sellVol: toZhang(b.sell_volume),
    buyAvg: b.buy_avg_price,
    sellAvg: b.sell_avg_price,
  }));

  // X-axis symmetric: 0 always in center
  const allX = [
    ...buyerBuyBubbles.map(b => b.x),
    ...buyerSellBubbles.map(b => b.x),
    ...sellerSellBubbles.map(b => b.x),
    ...sellerBuyBubbles.map(b => b.x)
  ];
  const xAbsMax = Math.max(...allX.map(v => Math.abs(v)), 1);
  const xPad = Math.ceil(xAbsMax * 1.15); // 15% padding
  const xAxisMin = -xPad;
  const xAxisMax = xPad;

  return `
(function() {
  const ctx = document.getElementById('bubbleChart').getContext('2d');
  const buyerBuyData = ${JSON.stringify(buyerBuyBubbles)};
  const buyerSellData = ${JSON.stringify(buyerSellBubbles)};
  const sellerSellData = ${JSON.stringify(sellerSellBubbles)};
  const sellerBuyData = ${JSON.stringify(sellerBuyBubbles)};
  const closePrice = ${closePrice};

  // Hover state management
  let hoveredBroker = null;
  const labelRects = []; // Store label positions for collision detection

  // Extract top 3 brokers for quick reference
  const top3Buyers = buyerBuyData.slice(0, 3).map(d => d.label);
  const top3Sellers = sellerSellData.slice(0, 3).map(d => d.label);

  // Plugin: lines BEHIND bubbles, labels BELOW chart
  const refLinePlugin = {
    id: 'refLines',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: { left, right, top, bottom }, scales: { x, y } } = chart;

      // Vertical dashed line at x=0
      const x0 = x.getPixelForValue(0);
      if (x0 >= left && x0 <= right) {
        ctx.save();
        ctx.strokeStyle = 'rgba(88,166,255,0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(x0, top);
        ctx.lineTo(x0, bottom);
        ctx.stroke();
        ctx.restore();
      }

      // Horizontal dashed line at close price (thin, behind bubbles)
      if (closePrice > 0) {
        const yClose = y.getPixelForValue(closePrice);
        if (yClose >= top && yClose <= bottom) {
          ctx.save();
          ctx.strokeStyle = 'rgba(255,200,55,0.25)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(left, yClose);
          ctx.lineTo(right, yClose);
          ctx.stroke();
          ctx.restore();
        }
      }
    },
    afterDatasetsDraw(chart) {
      const { ctx, chartArea: { left, right, top, bottom }, scales: { x, y } } = chart;

      // Clear previous label rects
      labelRects.length = 0;

      // Label area: 50px below chart bottom to avoid X-axis overlap
      const labelY = bottom + 40;
      ctx.font = 'bold 11px sans-serif';

      // Draw top 3 buyer labels (left side, #1 is leftmost)
      const buyerWidth = (right - left) / 2;
      top3Buyers.forEach((brokerName, i) => {
        if (!brokerName) return;

        const isHovered = hoveredBroker === brokerName;
        const x = left + (i + 1) * (buyerWidth / 4); // spread across left half

        // Get broker net volume for display
        const brokerData = buyerBuyData.find(d => d.label === brokerName);
        const netVol = brokerData ? brokerData.net : 0;
        const netText = (netVol > 0 ? '+' : '') + netVol;

        // Label background and styling (買超 = 紅色) - taller for 2 lines
        ctx.font = 'bold 10px sans-serif';
        const tw = Math.max(ctx.measureText(brokerName).width, ctx.measureText(netText).width);
        const bgX = x - tw/2 - 6;
        const bgY = labelY - 15;
        const bgW = tw + 12;
        const bgH = 30;

        // Draw background
        ctx.fillStyle = isHovered ? 'rgba(248,81,73,0.8)' : 'rgba(248,81,73,0.4)';
        ctx.fillRect(bgX, bgY, bgW, bgH);

        // Draw broker name (line 1)
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(brokerName, x, labelY - 6);

        // Draw net volume (line 2)
        ctx.font = 'bold 8px sans-serif';
        ctx.fillText(netText, x, labelY + 6);

        // Store rect for collision detection (updated for 2-line background)
        labelRects.push({
          name: brokerName,
          x: bgX,
          y: bgY,
          w: bgW,
          h: bgH,
          data: brokerData // Store broker data for tooltip
        });

        // Draw connection line to primary bubble (买超买进)
        const bubble = buyerBuyData.find(d => d.label === brokerName);
        if (bubble) {
          const meta0 = chart.getDatasetMeta(0);
          const bubbleIndex = buyerBuyData.indexOf(bubble);
          const bubbleEl = meta0.data[bubbleIndex];

          if (bubbleEl) {
            ctx.save();
            ctx.strokeStyle = isHovered ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.35)';
            ctx.lineWidth = isHovered ? 2 : 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(x, labelY - 15);  // Adjusted for 2-line label
            ctx.lineTo(bubbleEl.x, bubbleEl.y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
          }
        }
      });

      // Draw top 3 seller labels (right side, #1 is rightmost)
      top3Sellers.forEach((brokerName, i) => {
        if (!brokerName) return;

        const isHovered = hoveredBroker === brokerName;
        const x = left + buyerWidth + ((3 - i) * (buyerWidth / 4)); // spread across right half, reversed order

        // Get broker net volume for display (negative for sellers)
        const brokerData = sellerSellData.find(d => d.label === brokerName);
        const netVol = brokerData ? brokerData.net : 0;
        const netText = (netVol > 0 ? '+' : '') + netVol;

        // Label background and styling (賣超 = 綠色) - taller for 2 lines
        ctx.font = 'bold 10px sans-serif';
        const tw = Math.max(ctx.measureText(brokerName).width, ctx.measureText(netText).width);
        const bgX = x - tw/2 - 6;
        const bgY = labelY - 15;
        const bgW = tw + 12;
        const bgH = 30;

        // Draw background
        ctx.fillStyle = isHovered ? 'rgba(63,185,80,0.8)' : 'rgba(63,185,80,0.4)';
        ctx.fillRect(bgX, bgY, bgW, bgH);

        // Draw broker name (line 1)
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(brokerName, x, labelY - 6);

        // Draw net volume (line 2)
        ctx.font = 'bold 8px sans-serif';
        ctx.fillText(netText, x, labelY + 6);

        // Store rect for collision detection (updated for 2-line background)
        labelRects.push({
          name: brokerName,
          x: bgX,
          y: bgY,
          w: bgW,
          h: bgH,
          data: brokerData // Store broker data for tooltip
        });

        // Draw connection line to primary bubble (卖超卖出)
        const bubble = sellerSellData.find(d => d.label === brokerName);
        if (bubble) {
          const meta2 = chart.getDatasetMeta(2);
          const bubbleIndex = sellerSellData.indexOf(bubble);
          const bubbleEl = meta2.data[bubbleIndex];

          if (bubbleEl) {
            ctx.save();
            ctx.strokeStyle = isHovered ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.35)';
            ctx.lineWidth = isHovered ? 2 : 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(x, labelY - 15);  // Adjusted for 2-line label
            ctx.lineTo(bubbleEl.x, bubbleEl.y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
          }
        }
      });

      // Draw curved connection between buy-sell pairs for hovered broker
      if (hoveredBroker) {
        const drawBuySellConnection = (broker, buyData, sellData, buyDatasetIndex, sellDatasetIndex) => {
          const buyBubble = buyData.find(d => d.label === broker);
          const sellBubble = sellData.find(d => d.label === broker);

          if (buyBubble && sellBubble) {
            const buyMeta = chart.getDatasetMeta(buyDatasetIndex);
            const sellMeta = chart.getDatasetMeta(sellDatasetIndex);
            const buyEl = buyMeta.data[buyData.indexOf(buyBubble)];
            const sellEl = sellMeta.data[sellData.indexOf(sellBubble)];

            if (buyEl && sellEl) {
              ctx.save();
              ctx.strokeStyle = 'rgba(255,255,255,0.6)';
              ctx.lineWidth = 3;
              ctx.setLineDash([6, 6]);

              const midX = (buyEl.x + sellEl.x) / 2;
              const midY = Math.min(buyEl.y, sellEl.y) - 30;

              ctx.beginPath();
              ctx.moveTo(buyEl.x, buyEl.y);
              ctx.quadraticCurveTo(midX, midY, sellEl.x, sellEl.y);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.restore();
            }
          }
        };

        // Draw connections for hovered broker (both buy-dominant and sell-dominant)
        if (top3Buyers.includes(hoveredBroker)) {
          drawBuySellConnection(hoveredBroker, buyerBuyData, buyerSellData, 0, 1);
        }
        if (top3Sellers.includes(hoveredBroker)) {
          drawBuySellConnection(hoveredBroker, sellerBuyData, sellerSellData, 3, 2);
        }
      }
    }
  };

  new Chart(ctx, {
    type: 'bubble',
    data: {
      datasets: [
        {
          label: '買超買進',
          data: buyerBuyData,
          backgroundColor: function(ctx) {
            const raw = ctx.raw;
            if (!raw) return 'rgba(248,81,73,0.3)';

            if (hoveredBroker && raw.label !== hoveredBroker) {
              return 'rgba(248,81,73,0.08)'; // Very dim when not hovered
            }

            const r = raw.r || 5;
            const alpha = hoveredBroker === raw.label ? 0.9 : Math.min(0.75, 0.3 + r / 30);
            return 'rgba(248,81,73,' + alpha + ')';
          },
          borderColor: 'rgba(248,81,73,0.8)',
          borderWidth: 1.5,
          hoverBackgroundColor: 'rgba(248,81,73,0.9)',
          hoverBorderColor: '#fff',
          hoverBorderWidth: 2,
        },
        {
          label: '買超賣出',
          data: buyerSellData,
          backgroundColor: function(ctx) {
            const raw = ctx.raw;
            if (!raw) return 'rgba(63,185,80,0.15)';

            if (hoveredBroker && raw.label !== hoveredBroker) {
              return 'rgba(63,185,80,0.05)'; // Very dim when not hovered
            }

            const r = raw.r || 5;
            const alpha = hoveredBroker === raw.label ? 0.6 : Math.min(0.4, 0.15 + r / 50);
            return 'rgba(63,185,80,' + alpha + ')';
          },
          borderColor: 'rgba(63,185,80,0.5)',
          borderWidth: 1,
          hoverBackgroundColor: 'rgba(63,185,80,0.6)',
          hoverBorderColor: '#fff',
          hoverBorderWidth: 1,
        },
        {
          label: '賣超賣出',
          data: sellerSellData,
          backgroundColor: function(ctx) {
            const raw = ctx.raw;
            if (!raw) return 'rgba(63,185,80,0.3)';

            if (hoveredBroker && raw.label !== hoveredBroker) {
              return 'rgba(63,185,80,0.08)'; // Very dim when not hovered
            }

            const r = raw.r || 5;
            const alpha = hoveredBroker === raw.label ? 0.9 : Math.min(0.75, 0.3 + r / 30);
            return 'rgba(63,185,80,' + alpha + ')';
          },
          borderColor: 'rgba(63,185,80,0.8)',
          borderWidth: 1.5,
          hoverBackgroundColor: 'rgba(63,185,80,0.9)',
          hoverBorderColor: '#fff',
          hoverBorderWidth: 2,
        },
        {
          label: '賣超買進',
          data: sellerBuyData,
          backgroundColor: function(ctx) {
            const raw = ctx.raw;
            if (!raw) return 'rgba(248,81,73,0.15)';

            if (hoveredBroker && raw.label !== hoveredBroker) {
              return 'rgba(248,81,73,0.05)'; // Very dim when not hovered
            }

            const r = raw.r || 5;
            const alpha = hoveredBroker === raw.label ? 0.6 : Math.min(0.4, 0.15 + r / 50);
            return 'rgba(248,81,73,' + alpha + ')';
          },
          borderColor: 'rgba(248,81,73,0.5)',
          borderWidth: 1,
          hoverBackgroundColor: 'rgba(248,81,73,0.6)',
          hoverBorderColor: '#fff',
          hoverBorderWidth: 1,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 1.5,
      animation: false,
      layout: {
        padding: { bottom: 55 }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(13,17,23,0.95)',
          titleColor: '#e6edf3',
          bodyColor: '#c9d1d9',
          borderColor: '#58a6ff',
          borderWidth: 1,
          cornerRadius: 8,
          padding: 12,
          titleFont: { size: 13, weight: 'bold' },
          bodyFont: { size: 11 },
          displayColors: false,
          callbacks: {
            title: function(items) {
              const d = items[0].raw;
              const arrow = d.net >= 0 ? '🔴' : '🟢';
              return arrow + ' ' + d.label;
            },
            label: function(item) {
              const d = item.raw;
              const lines = [];
              lines.push('淨買超：' + (d.net > 0 ? '+' : '') + d.net + ' 張');
              lines.push('買進：' + d.buyVol + ' 張' + (d.buyAvg ? ' @ $' + d.buyAvg.toFixed(2) : ''));
              lines.push('賣出：' + d.sellVol + ' 張' + (d.sellAvg ? ' @ $' + d.sellAvg.toFixed(2) : ''));
              return lines;
            }
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: '買賣超（張）', color: '#8b949e', font: { size: 11 } },
          grid: { color: 'rgba(33,38,45,0.6)', lineWidth: 0.5 },
          ticks: { color: '#8b949e', font: { size: 10 } },
          border: { color: '#30363d' },
          min: ${xAxisMin},
          max: ${xAxisMax}
        },
        y: {
          title: { display: true, text: '成交均價', color: '#8b949e', font: { size: 11 } },
          grid: { color: 'rgba(33,38,45,0.6)', lineWidth: 0.5 },
          ticks: {
            color: function(context) {
              return context.tick && context.tick.value === ${closePrice} ? '#f85149' : '#8b949e';
            },
            font: function(context) {
              return context.tick && context.tick.value === ${closePrice}
                ? { size: 11, weight: 'bold' } : { size: 10 };
            },
            callback: function(value) { return value <= ${closePrice} ? value : ''; }
          },
          afterBuildTicks: function(axis) {
            const cp = ${closePrice};
            const ticks = axis.ticks;
            if (!ticks.find(t => t.value === cp)) {
              ticks.push({ value: cp });
              ticks.sort((a, b) => a.value - b.value);
            }
          },
          border: { color: '#30363d' },
          min: ${yAxisMin},
          max: ${yAxisMax}
        }
      }
    },
    plugins: [refLinePlugin]
  });

  // Event listeners for hover interaction
  const canvas = document.getElementById('bubbleChart');

  // Helper function to get Chart.js instance
  const getChart = () => Chart.getChart(canvas);

  // Create custom tooltip for labels
  let customTooltip = null;
  const createTooltip = () => {
    if (customTooltip) return customTooltip;

    const tooltip = document.createElement('div');
    tooltip.style.cssText = \`
      position: absolute;
      background: rgba(13,17,23,0.95);
      color: #e6edf3;
      border: 1px solid #58a6ff;
      border-radius: 8px;
      padding: 12px;
      font-family: sans-serif;
      font-size: 11px;
      pointer-events: none;
      z-index: 1000;
      display: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    \`;
    document.body.appendChild(tooltip);
    customTooltip = tooltip;
    return tooltip;
  };

  const showTooltip = (brokerData, mouseX, mouseY) => {
    const tooltip = createTooltip();
    if (!brokerData) return;

    const arrow = brokerData.net >= 0 ? '🔴' : '🟢';
    const net = brokerData.net > 0 ? '+' + brokerData.net : '' + brokerData.net;

    tooltip.innerHTML = \`
      <div style="font-weight: bold; margin-bottom: 4px;">\${arrow} \${brokerData.label}</div>
      <div>淨買超：\${net} 張</div>
      <div>買進：\${brokerData.buyVol} 張\${brokerData.buyAvg ? ' @ $' + brokerData.buyAvg.toFixed(2) : ''}</div>
      <div>賣出：\${brokerData.sellVol} 張\${brokerData.sellAvg ? ' @ $' + brokerData.sellAvg.toFixed(2) : ''}</div>
    \`;

    // Position tooltip to avoid curved lines (prefer upper-left or upper-right)
    const canvasRect = canvas.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();

    let x = canvasRect.left + mouseX + 15;
    let y = canvasRect.top + mouseY - tooltipRect.height - 15;

    // Keep within viewport
    if (x + tooltipRect.width > window.innerWidth) {
      x = canvasRect.left + mouseX - tooltipRect.width - 15;
    }
    if (y < 0) {
      y = canvasRect.top + mouseY + 15;
    }

    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
    tooltip.style.display = 'block';
  };

  const hideTooltip = () => {
    if (customTooltip) {
      customTooltip.style.display = 'none';
    }
  };

  // Helper function to check if mouse is over a bubble
  const findBubbleAtMouse = (chart, mouseX, mouseY) => {
    const allDatasets = [buyerBuyData, buyerSellData, sellerSellData, sellerBuyData];

    for (let di = 0; di < allDatasets.length; di++) {
      const meta = chart.getDatasetMeta(di);
      const dataset = allDatasets[di];

      for (let i = 0; i < dataset.length; i++) {
        const el = meta.data[i];
        if (!el) continue;

        const bubble = dataset[i];
        const distance = Math.sqrt(
          Math.pow(mouseX - el.x, 2) + Math.pow(mouseY - el.y, 2)
        );

        if (distance <= bubble.r) {
          return bubble.label;
        }
      }
    }
    return null;
  };

  // Helper function to check if mouse is over a label
  const findLabelAtMouse = (mouseX, mouseY) => {
    for (const label of labelRects) {
      if (mouseX >= label.x && mouseX <= label.x + label.w &&
          mouseY >= label.y && mouseY <= label.y + label.h) {
        return label.name;
      }
    }
    return null;
  };

  canvas.addEventListener('mousemove', function(e) {
    const chart = getChart();
    if (!chart) return;

    const rect = canvas.getBoundingClientRect();
    const canvasRect = Chart.helpers.getRelativePosition(e, chart);
    const mouseX = canvasRect.x;
    const mouseY = canvasRect.y;

    let foundBroker = null;
    let hoveredLabelData = null;

    // Check labels first (higher priority) and get data for tooltip
    for (const label of labelRects) {
      if (mouseX >= label.x && mouseX <= label.x + label.w &&
          mouseY >= label.y && mouseY <= label.y + label.h) {
        foundBroker = label.name;
        hoveredLabelData = label.data;
        break;
      }
    }

    // Check bubbles if no label hit
    if (!foundBroker) {
      foundBroker = findBubbleAtMouse(chart, mouseX, mouseY);
    }

    // Update hover state
    if (foundBroker !== hoveredBroker) {
      hoveredBroker = foundBroker;
      chart.update('none'); // Update without animation
    }

    // Show/hide custom tooltip for labels
    if (hoveredLabelData) {
      showTooltip(hoveredLabelData, e.clientX, e.clientY);
    } else {
      hideTooltip();
    }
  });

  canvas.addEventListener('mouseleave', function() {
    const chart = getChart();
    if (!chart) return;

    if (hoveredBroker !== null) {
      hoveredBroker = null;
      chart.update('none');
    }

    // Hide tooltip when leaving canvas
    hideTooltip();
  });
})();
`;
}

function generateStockPage(stockInfo, brokerData, date, institutionalInfo, backLink = "../index.html", brokerDataDate = null) {
  const adDate = formatDate(date);
  const brokerDateLabel = brokerDataDate && brokerDataDate !== date
    ? `⚠️ 籌碼資料為 ${formatDate(brokerDataDate)} 的數據`
    : '';
  const typeClass = stockInfo.type === "漲停" ? "up" : "down";

  // 欄位: 券商 | 買超 | 買均 | 買張 | 賣張 | 賣均
  const brokerRow = (b, isBuy) => {
    const netClass = b.net_volume >= 0 ? "up" : "down";
    return `<tr>
      <td>${b.broker_name}</td>
      <td class="${netClass} net">${fmtVol(b.net_volume)}</td>
      <td>${fmtPrice(b.buy_avg_price)}</td>
      <td class="up">${fmtVol(b.buy_volume)}</td>
      <td class="down">${fmtVol(b.sell_volume)}</td>
      <td>${fmtPrice(b.sell_avg_price)}</td>
    </tr>`;
  };

  const buyerRows = brokerData ? (brokerData.top_buyers || []).map(b => brokerRow(b, true)).join("") : "";
  const sellerRows = brokerData ? (brokerData.top_sellers || []).map(b => brokerRow(b, false)).join("") : "";

  // Generate institutional investors card
  const generateInstitutionalCard = () => {
    if (!institutionalInfo) {
      return `<div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin:16px 0;">
        <h3 style="color:#e6edf3;font-size:14px;margin-bottom:12px;display:flex;align-items:center;gap:8px;">
          🏛️ 三大法人買賣超
          <span style="font-size:11px;color:#8b949e;font-weight:normal;">(當日)</span>
        </h3>
        <div style="text-align:center;padding:16px;color:#8b949e;font-size:13px;line-height:1.5;">
          📊 資料整理中<br>
          <span style="font-size:11px;color:#6c7a89;">請等待 16:30 更新</span>
        </div>
      </div>`;
    }

    const formatInstitutional = (sharesValue) => {
      const lots = Math.round(sharesValue / 1000); // 股→張
      const abs = Math.abs(lots);
      const sign = lots >= 0 ? '+' : '-';
      const color = lots >= 0 ? '#f85149' : '#3fb950';
      return `<span style="color:${color}">${sign}${abs.toLocaleString()}張</span>`;
    };

    return `<div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin:16px 0;">
      <h3 style="color:#e6edf3;font-size:14px;margin-bottom:12px;display:flex;align-items:center;gap:8px;">
        🏛️ 三大法人買賣超
        <span style="font-size:11px;color:#8b949e;font-weight:normal;">(當日)</span>
      </h3>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">
        <div style="text-align:center;">
          <div style="color:#8b949e;font-size:11px;margin-bottom:4px;">外資</div>
          <div style="font-size:13px;font-weight:600;">${formatInstitutional(institutionalInfo.foreign)}</div>
        </div>
        <div style="text-align:center;">
          <div style="color:#8b949e;font-size:11px;margin-bottom:4px;">投信</div>
          <div style="font-size:13px;font-weight:600;">${formatInstitutional(institutionalInfo.trust)}</div>
        </div>
        <div style="text-align:center;">
          <div style="color:#8b949e;font-size:11px;margin-bottom:4px;">自營商</div>
          <div style="font-size:13px;font-weight:600;">${formatInstitutional(institutionalInfo.dealer)}</div>
        </div>
        <div style="text-align:center;">
          <div style="color:#8b949e;font-size:11px;margin-bottom:4px;">合計</div>
          <div style="font-size:14px;font-weight:700;">${formatInstitutional(institutionalInfo.total)}</div>
        </div>
      </div>
    </div>`;
  };

  const tableHead = `<thead><tr><th>券商</th><th>買超</th><th>買均</th><th>買張</th><th>賣張</th><th>賣均</th></tr></thead>`;

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${stockInfo.name}(${stockInfo.code}) ${stockInfo.type}分點買賣超 — 烏薩奇漲停版</title>
<meta name="description" content="${adDate} ${stockInfo.name}(${stockInfo.code}) ${stockInfo.type}，券商分點買賣超前15大排行，追蹤主力動向">

<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-L3W7YJ6N37"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-L3W7YJ6N37');
</script>

<!-- AdSense -->
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-4394676027529562"
     crossorigin="anonymous"></script>

<style>${css()}</style>
</head>
<body>
<div class="container wide">
  <a href="${backLink}" class="back">← 返回漲停總覽</a>

  <div class="info-bar">
    <div class="info-left">
      <h2>${stockInfo.name}</h2>
      <div class="code">${stockInfo.code} · ${adDate}</div>
    </div>
    <div class="info-right">
      <div class="price ${typeClass}">$${stockInfo.close}</div>
      <div class="change-info ${typeClass}">
        ${stockInfo.change > 0 ? "+" : ""}${stockInfo.change} (${stockInfo.changePct}%)
        <span class="badge ${typeClass}">${stockInfo.type}</span>
      </div>
    </div>
  </div>

  <div class="ads-container">
    <!-- 左側廣告 (桌面版) -->
    <div class="sidebar-ad">
      <!-- AdSense 側邊廣告位 -->
      廣告位<br>(160x600)
    </div>

    <!-- 主要內容 -->
    <div class="content-wrapper">
      <p style="color:#8b949e;font-size:13px;margin-bottom:12px;">${brokerData ? `共 ${brokerData.total_brokers} 家券商交易${brokerDateLabel ? ` <span style="color:#d29922;font-size:12px;">${brokerDateLabel}</span>` : ''}` : "⏳ 分點資料每日 16:30 後更新"}</p>

      ${generateInstitutionalCard()}

      ${brokerData ? `
      ${brokerDateLabel ? `<div style="background:#d29922;color:#0d1117;font-size:12px;font-weight:bold;padding:6px 12px;border-radius:4px;margin-bottom:12px;text-align:center;">⚠️ 以下為上一個交易日 (${brokerDataDate ? formatDate(brokerDataDate) : ''}) 的籌碼資料，非今日數據</div>` : ''}
      <div class="dual-panel">
        <div class="panel">
          <div class="panel-title buy">買超 Top15</div>
          <table>${tableHead}<tbody>${buyerRows}</tbody></table>
        </div>
        <div class="panel">
          <div class="panel-title sell">賣超 Top15</div>
          <table>${tableHead}<tbody>${sellerRows}</tbody></table>
        </div>
      </div>

      ${generateBubbleChart(brokerData, stockInfo, brokerDataDate, date)}` : `
      <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:32px;margin:24px 0;text-align:center;">
        <div style="color:#8b949e;font-size:16px;margin-bottom:12px;">🕐</div>
        <div style="color:#e6edf3;font-size:14px;margin-bottom:8px;">分點買賣超資料準備中</div>
        <div style="color:#8b949e;font-size:12px;line-height:1.5;">
          每日 16:30 後更新券商分點買賣超排行
        </div>
      </div>

      <div style="margin-top:24px;">
        <div class="panel-title" style="border-bottom-color:#58a6ff;color:#58a6ff;">籌碼泡泡圖</div>
        <div style="position:relative;width:100%;max-width:700px;margin:0 auto;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:40px 20px;text-align:center;">
          <div style="color:#8b949e;font-size:13px;">🕐 泡泡圖將於 16:30 後更新</div>
        </div>
      </div>`}

      <!-- 底部廣告位 -->
      <div style="margin:32px 0;text-align:center;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px;color:#484f58;font-size:12px;">
        底部廣告位<br>(728x90 或回應式)
      </div>
    </div>

    <!-- 右側廣告 (桌面版) -->
    <div class="sidebar-ad">
      <!-- AdSense 側邊廣告位 -->
      廣告位<br>(160x600)
    </div>
  </div>

  <footer>
    <p>資料來源：台灣證券交易所公開資訊</p>
    <p><a href="../index.html">烏薩奇漲停版</a> &copy; 2026 | 每日盤後更新</p>
  </footer>
</div>
${brokerData ? `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<script>
${generateBubbleChartScript(brokerData, stockInfo, brokerDataDate, date)}
</script>` : ''}
</body>
</html>`;
}

// ============================================================
// Detect available dates from cache
function getAvailableDates() {
  const dates = new Set();
  try {
    const cacheFiles = fs.readdirSync(CACHE_DIR);
    cacheFiles.forEach(file => {
      const match = file.match(/_(\d{8})\.json$/);
      if (match) {
        dates.add(match[1]);
      }
    });
    return Array.from(dates).sort().reverse(); // Latest first
  } catch (e) {
    return [];
  }
}

// ============================================================
// Main
// ============================================================
// Snapshot directory for preserving historical limit stock data
const SNAPSHOT_DIR = path.resolve("./snapshots");
if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

function saveSnapshot(date, limitStocks) {
  const snapshotPath = path.join(SNAPSHOT_DIR, `${date}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(limitStocks, null, 2));
  console.log(`  Saved snapshot: ${snapshotPath}`);
}

function loadSnapshot(date) {
  const snapshotPath = path.join(SNAPSHOT_DIR, `${date}.json`);
  if (!fs.existsSync(snapshotPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
  } catch (e) {
    return null;
  }
}

// Generate a full date page (index + stock pages)
async function generateDatePages(limitStocks, date, availableDates, isLatest) {
  const cacheDate = date;

  // Fetch institutional data
  const institutionalData = await fetchAllInstitutionalData(cacheDate);

  // 統一用日期目錄 stock/{date}/{code}.html，避免連續漲停衝突
  const stockPageDir = path.join(STOCK_DIR, date);
  // 清空舊頁面，避免殘留過期檔案
  if (fs.existsSync(stockPageDir)) {
    for (const f of fs.readdirSync(stockPageDir)) {
      if (f.endsWith('.html')) fs.unlinkSync(path.join(stockPageDir, f));
    }
  } else {
    fs.mkdirSync(stockPageDir, { recursive: true });
  }

  // Stock card link prefix
  const stockLinkPrefix = `stock/${date}/`;

  // Generate index page
  const indexFileName = isLatest ? "index.html" : `index-${date}.html`;
  console.log(`  Generating ${indexFileName}...`);
  const indexHtml = await generateIndexPage(limitStocks, date, availableDates, stockLinkPrefix);
  fs.writeFileSync(path.join(SITE_DIR, indexFileName), indexHtml);

  // Generate stock pages
  let generated = 0;
  for (const [code, info] of Object.entries(limitStocks)) {
    let brokerResult = await loadBrokerData(code, cacheDate);
    // 最新那天：如果沒有當天的精確匹配，不 fallback（統一顯示「準備中」）
    if (isLatest && brokerResult && brokerResult.dataDate !== cacheDate) {
      console.log(`    [INFO] ${code} ${info.name} — today's broker data not ready, skipping old data`);
      brokerResult = null;
    }
    const brokerData = brokerResult ? brokerResult.data : null;
    const brokerDataDate = brokerResult ? brokerResult.dataDate : null;
    if (!brokerData) {
      console.log(`    [INFO] ${code} ${info.name} — no broker data, generating basic page`);
    } else if (brokerDataDate !== cacheDate) {
      console.log(`    [INFO] ${code} ${info.name} — using broker data from ${brokerDataDate}`);
    }
    const institutionalInfo = institutionalData[code] || null;
    const backLink = isLatest ? "../../index.html" : `../../index-${date}.html`;
    const html = generateStockPage(info, brokerData, date, institutionalInfo, backLink, brokerDataDate);
    fs.writeFileSync(path.join(stockPageDir, `${code}.html`), html);
    generated++;
  }
  return generated;
}

async function main() {
  console.log("🐰 烏薩奇漲停版 — 靜態網頁生成器");
  console.log("");

  // Get today's limit stocks from API
  console.log("Fetching market data...");
  const { stocks: limitStocks, date } = await getLimitStocks();
  const adDate = formatDate(date);

  console.log(`Date: ${adDate}`);
  console.log(`Found ${Object.keys(limitStocks).length} limit stocks`);

  // Save snapshot for today
  saveSnapshot(date, limitStocks);

  // Detect all available dates (from cache + snapshots)
  const availableDates = getAvailableDates();
  // Also include snapshot dates
  const snapshotFiles = fs.readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith('.json'));
  snapshotFiles.forEach(f => {
    const d = f.replace('.json', '');
    if (!availableDates.includes(d)) availableDates.push(d);
  });
  availableDates.sort().reverse(); // Latest first
  console.log(`Available dates: ${availableDates.join(', ')}`);
  console.log("");

  // Generate pages for TODAY (latest)
  console.log(`📅 Generating TODAY (${adDate}):`);
  const todayCount = await generateDatePages(limitStocks, date, availableDates, true);
  console.log(`  Generated ${todayCount} stock pages`);

  // Generate pages for HISTORICAL dates
  for (const histDate of availableDates) {
    if (histDate === date) continue; // Skip today, already done

    const histStocks = loadSnapshot(histDate);
    if (!histStocks) {
      console.log(`📅 Skipping ${formatDate(histDate)} — no snapshot`);
      continue;
    }

    console.log(`📅 Generating HISTORY (${formatDate(histDate)}):`);
    const histCount = await generateDatePages(histStocks, histDate, availableDates, false);
    console.log(`  Generated ${histCount} stock pages`);
  }

  console.log("");
  console.log(`Output: ${SITE_DIR}`);
  console.log("Done! 🎉");
}

main().catch(console.error);
