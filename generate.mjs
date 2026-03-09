/**
 * 烏薩奇漲停版 — 靜態網頁生成器
 * 讀取 twse-broker-mcp/cache 中的分點資料，生成靜態 HTML 頁面
 */

import fs from "fs";
import path from "path";
import axios from "axios";

const CACHE_DIR = path.resolve("../twse-broker-mcp/cache");
const SITE_DIR = path.resolve("./site");

// Ensure output dirs exist
if (!fs.existsSync(SITE_DIR)) fs.mkdirSync(SITE_DIR, { recursive: true });
const STOCK_DIR = path.join(SITE_DIR, "stock");
if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });

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

    // 只追蹤漲停（跌停暫不處理）
    if (!(close === high && pct >= 9.5)) continue;

    {
      const type = "漲停";
      stocks[s.Code] = {
        code: s.Code,
        name: s.Name,
        close,
        change,
        changePct: pct.toFixed(2),
        volume: parseInt(String(s.TradeVolume).replace(/,/g, '')),
        type,
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

      if (!(close === high && pct >= 9.5)) continue;

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
function loadBrokerData(stockCode, date) {
  // date format: YYYYMMDD
  const file = path.join(CACHE_DIR, `${stockCode}_${date}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

// ============================================================
// Step 3: Generate HTML
// ============================================================
function css() {
  return `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #0d1117; color: #e6edf3; font-family: -apple-system, 'Segoe UI', sans-serif; }
.container { max-width: 800px; margin: 0 auto; padding: 16px; }
header { text-align: center; padding: 24px 0 16px; border-bottom: 1px solid #30363d; margin-bottom: 20px; }
header h1 { font-size: 24px; margin-bottom: 4px; }
header h1 span.rabbit { font-size: 28px; }
header .subtitle { color: #8b949e; font-size: 14px; }
header .date { color: #58a6ff; font-size: 16px; margin-top: 8px; }

.section-title { font-size: 18px; margin: 24px 0 12px; padding-left: 8px; border-left: 3px solid #f85149; }
.section-title.down { border-left-color: #3fb950; }

.stock-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
.stock-card a { text-decoration: none; color: inherit; display: block; padding: 14px 16px; }
.stock-card a:hover { background: #1c2129; }
.stock-header { display: flex; justify-content: space-between; align-items: center; }
.stock-name { font-size: 16px; font-weight: 600; }
.stock-code { color: #8b949e; font-size: 13px; margin-left: 8px; }
.stock-price { text-align: right; }
.stock-close { font-size: 16px; font-weight: 600; }
.stock-change { font-size: 13px; margin-top: 2px; }
.up { color: #f85149; }
.down { color: #3fb950; }
.stock-meta { display: flex; justify-content: space-between; margin-top: 8px; font-size: 12px; color: #8b949e; }

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

.tab-bar { display: flex; margin-bottom: 16px; }
.tab { flex: 1; text-align: center; padding: 10px; font-size: 14px; font-weight: 600; cursor: pointer; border-bottom: 2px solid #30363d; }
.tab.active-buy { border-bottom-color: #f85149; color: #f85149; }
.tab.active-sell { border-bottom-color: #3fb950; color: #3fb950; }

table { width: 100%; border-collapse: collapse; }
th { text-align: left; padding: 8px 12px; font-size: 12px; color: #8b949e; border-bottom: 1px solid #30363d; }
th:nth-child(n+2) { text-align: right; }
td { padding: 10px 12px; font-size: 14px; border-bottom: 1px solid #21262d; }
td:nth-child(n+2) { text-align: right; font-variant-numeric: tabular-nums; }
tr:hover { background: #1c2129; }
.rank { color: #8b949e; width: 30px; }

footer { text-align: center; padding: 32px 0 24px; color: #484f58; font-size: 12px; border-top: 1px solid #30363d; margin-top: 32px; }
footer a { color: #58a6ff; text-decoration: none; }

@media (max-width: 600px) {
  .container { padding: 12px; }
  .info-bar { flex-direction: column; text-align: center; gap: 12px; }
  .info-right { text-align: center; }
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

function formatVolume(v) {
  if (v >= 100000000) return (v / 100000000).toFixed(1) + "億";
  if (v >= 10000) return (v / 10000).toFixed(0) + "萬";
  return v.toLocaleString();
}

function generateIndexPage(limitStocks, date) {
  const adDate = formatDate(date);
  const upStocks = Object.values(limitStocks);

  const stockCard = (s) => `
    <div class="stock-card">
      <a href="stock/${s.code}.html">
        <div class="stock-header">
          <div><span class="stock-name">${s.name}</span><span class="stock-code">${s.code}</span></div>
          <div class="stock-price">
            <div class="stock-close up">$${s.close}</div>
            <div class="stock-change up">+${s.change} (${s.changePct}%)</div>
          </div>
        </div>
        <div class="stock-meta">
          <span>成交量 ${formatVolume(s.volume)}</span>
          <span class="badge up">漲停${s.market === 'OTC' ? '(櫃)' : ''}</span>
        </div>
      </a>
    </div>`;

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>烏薩奇漲停版 — ${adDate} 漲停分點追蹤</title>
<meta name="description" content="${adDate} 台股漲停股票券商分點買賣超排行，追蹤主力動向">
<style>${css()}</style>
</head>
<body>
<div class="container">
  <header>
    <h1><span class="rabbit">🐰</span> 烏薩奇漲停版</h1>
    <div class="subtitle">漲停分點追蹤 — 看誰在買、誰在賣</div>
    <div class="date">${adDate}</div>
  </header>

  <div class="section-title">🔴 漲停 (${upStocks.length})</div>
  ${upStocks.map(stockCard).join("\n")}

  <footer>
    <p>資料來源：台灣證券交易所公開資訊</p>
    <p>烏薩奇漲停版 &copy; 2026 | 每日盤後更新</p>
  </footer>
</div>
</body>
</html>`;
}

function generateStockPage(stockInfo, brokerData, date) {
  const adDate = formatDate(date);
  const typeClass = stockInfo.type === "漲停" ? "up" : "down";

  const buyerRows = (brokerData.top_buyers || []).map((b, i) => `
    <tr>
      <td class="rank">${i + 1}</td>
      <td>${b.broker_name}</td>
      <td class="up">${(b.buy_volume / 1000).toFixed(0)}</td>
      <td class="down">${(b.sell_volume / 1000).toFixed(0)}</td>
      <td class="up" style="font-weight:600">${(b.net_volume / 1000).toFixed(0)}</td>
    </tr>`).join("");

  const sellerRows = (brokerData.top_sellers || []).map((b, i) => `
    <tr>
      <td class="rank">${i + 1}</td>
      <td>${b.broker_name}</td>
      <td class="up">${(b.buy_volume / 1000).toFixed(0)}</td>
      <td class="down">${(b.sell_volume / 1000).toFixed(0)}</td>
      <td class="down" style="font-weight:600">${(b.net_volume / 1000).toFixed(0)}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${stockInfo.name}(${stockInfo.code}) ${stockInfo.type}分點買賣超 — 烏薩奇漲停版</title>
<meta name="description" content="${adDate} ${stockInfo.name}(${stockInfo.code}) ${stockInfo.type}，券商分點買賣超前15大排行，追蹤主力動向">
<style>${css()}</style>
</head>
<body>
<div class="container">
  <a href="../index.html" class="back">← 返回漲跌停總覽</a>

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

  <p style="color:#8b949e;font-size:13px;margin-bottom:20px;">共 ${brokerData.total_brokers} 家券商交易</p>

  <!-- Buy Top 15 -->
  <div class="tab-bar">
    <div class="tab active-buy">買方 Top15</div>
  </div>
  <table>
    <thead>
      <tr><th class="rank">#</th><th>券商</th><th>買(張)</th><th>賣(張)</th><th>買超(張)</th></tr>
    </thead>
    <tbody>${buyerRows}</tbody>
  </table>

  <!-- Sell Top 15 -->
  <div class="tab-bar" style="margin-top:32px;">
    <div class="tab active-sell">賣方 Top15</div>
  </div>
  <table>
    <thead>
      <tr><th class="rank">#</th><th>券商</th><th>買(張)</th><th>賣(張)</th><th>賣超(張)</th></tr>
    </thead>
    <tbody>${sellerRows}</tbody>
  </table>

  <footer>
    <p>資料來源：台灣證券交易所公開資訊</p>
    <p><a href="../index.html">烏薩奇漲停版</a> &copy; 2026 | 每日盤後更新</p>
  </footer>
</div>
</body>
</html>`;
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log("🐰 烏薩奇漲停版 — 靜態網頁生成器");
  console.log("");

  // Get limit stocks
  console.log("Fetching market data...");
  const { stocks: limitStocks, date } = await getLimitStocks();
  // date is now YYYYMMDD from TWSE API (or converted from ROC)
  const cacheDate = date; // direct match
  const adDate = formatDate(date);

  console.log(`Date: ${adDate} (cache key: ${cacheDate})`);
  console.log(`Found ${Object.keys(limitStocks).length} limit stocks`);
  console.log("");

  // Generate index page
  console.log("Generating index.html...");
  fs.writeFileSync(path.join(SITE_DIR, "index.html"), generateIndexPage(limitStocks, date));

  // Generate stock pages
  let generated = 0;
  for (const [code, info] of Object.entries(limitStocks)) {
    const brokerData = loadBrokerData(code, cacheDate);
    if (!brokerData) {
      console.log(`  [SKIP] ${code} ${info.name} — no broker data cached`);
      continue;
    }
    const html = generateStockPage(info, brokerData, date);
    fs.writeFileSync(path.join(STOCK_DIR, `${code}.html`), html);
    generated++;
  }

  console.log(`Generated ${generated} stock pages`);
  console.log(`Output: ${SITE_DIR}`);
  console.log("Done! 🎉");
}

main().catch(console.error);
