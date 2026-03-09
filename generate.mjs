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
  // date format: YYYYMMDD — try exact match first, then nearby dates (±1 day)
  const file = path.join(CACHE_DIR, `${stockCode}_${date}.json`);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch {}
  }
  // Fallback: find any cache for this stock with nearby date
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(stockCode + "_") && f.endsWith(".json"));
    if (files.length > 0) {
      // Pick the one closest to target date
      files.sort((a, b) => {
        const da = a.match(/_(\d{8})\.json$/)?.[1] || "";
        const db = b.match(/_(\d{8})\.json$/)?.[1] || "";
        return Math.abs(parseInt(da) - parseInt(date)) - Math.abs(parseInt(db) - parseInt(date));
      });
      const best = files[0];
      const bestDate = best.match(/_(\d{8})\.json$/)?.[1] || "";
      if (Math.abs(parseInt(bestDate) - parseInt(date)) <= 1) {
        return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, best), "utf-8"));
      }
    }
  } catch {}
  return null;
}

// ============================================================
// Step 3: Generate HTML
// ============================================================
function css() {
  return `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #0d1117; color: #e6edf3; font-family: -apple-system, 'Segoe UI', sans-serif; }
.container { max-width: 800px; margin: 0 auto; padding: 16px; }
.container.wide { max-width: 1200px; }
header { text-align: center; padding: 24px 0 16px; border-bottom: 1px solid #30363d; margin-bottom: 20px; }
header h1 { font-size: 24px; margin-bottom: 4px; }
header h1 span.rabbit { font-size: 28px; }
header .subtitle { color: #8b949e; font-size: 14px; }
header .date { color: #58a6ff; font-size: 16px; margin-top: 8px; }

.section-title { font-size: 18px; margin: 24px 0 12px; padding-left: 8px; border-left: 3px solid #f85149; }

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

@media (max-width: 700px) {
  .container { padding: 4px; }
  .info-bar { flex-direction: column; text-align: center; gap: 12px; }
  .info-right { text-align: center; }
  .dual-panel { gap: 4px; }
  th { padding: 2px 2px; font-size: 9px; }
  td { padding: 3px 2px; font-size: 9px; }
  td:first-child { max-width: 52px; font-size: 9px; }
  .panel-title { font-size: 11px; padding: 6px; }
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

function fmtVol(v) {
  // volume in shares → 張 (lots of 1000)
  return (v / 1000).toFixed(0);
}

function fmtPrice(p) {
  if (!p) return "-";
  return p.toFixed(2);
}

function generateBubbleChart(brokerData, stockInfo) {
  return `
  <div style="margin-top:24px;">
    <div class="panel-title" style="border-bottom-color:#58a6ff;color:#58a6ff;">籌碼泡泡圖</div>
    <div style="position:relative;width:100%;max-width:700px;margin:0 auto;">
      <canvas id="bubbleChart"></canvas>
    </div>
    <div style="display:flex;justify-content:center;gap:16px;margin-top:8px;flex-wrap:wrap;">
      <span style="color:#484f58;font-size:10px;">⬤ 大泡泡＝成交量大</span>
      <span style="color:#484f58;font-size:10px;">── 收盤價 $${stockInfo.close}</span>
      <span style="color:#484f58;font-size:10px;">┆ 買賣分界</span>
    </div>
  </div>`;
}

function generateBubbleChartScript(brokerData, stockInfo) {
  const closePrice = parseFloat(stockInfo.close) || 0;

  // Normalized sqrt: biggest = 14px, smallest proportionally shrinks
  const toZhang = (v) => Math.round(v / 1000);
  const allBrokers = [...(brokerData.top_buyers || []), ...(brokerData.top_sellers || [])];
  const maxVol = Math.max(...allBrokers.map(b => (b.buy_volume + b.sell_volume) / 1000), 1);
  const MAX_R = 14, MIN_R = 2;
  const calcR = (buyVol, sellVol) => {
    const total = (buyVol + sellVol) / 1000;
    if (total <= 0) return MIN_R;
    return MIN_R + (MAX_R - MIN_R) * Math.sqrt(total / maxVol);
  };

  const buyers = (brokerData.top_buyers || []).map(b => ({
    x: toZhang(b.net_volume),
    y: b.buy_avg_price || 0,
    r: calcR(b.buy_volume, b.sell_volume),
    label: b.broker_name,
    net: toZhang(b.net_volume),
    buyVol: toZhang(b.buy_volume),
    sellVol: toZhang(b.sell_volume),
    buyAvg: b.buy_avg_price,
    sellAvg: b.sell_avg_price,
  }));
  const sellers = (brokerData.top_sellers || []).map(b => ({
    x: toZhang(b.net_volume),
    y: b.sell_avg_price || 0,
    r: calcR(b.buy_volume, b.sell_volume),
    label: b.broker_name,
    net: toZhang(b.net_volume),
    buyVol: toZhang(b.buy_volume),
    sellVol: toZhang(b.sell_volume),
    buyAvg: b.buy_avg_price,
    sellAvg: b.sell_avg_price,
  }));

  return `
(function() {
  const ctx = document.getElementById('bubbleChart').getContext('2d');
  const buyData = ${JSON.stringify(buyers)};
  const sellData = ${JSON.stringify(sellers)};
  const closePrice = ${closePrice};

  // Plugin: reference lines + top broker labels (drawn ABOVE bubbles)
  const refLinePlugin = {
    id: 'refLines',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea: { left, right, top, bottom }, scales: { x, y } } = chart;

      // Vertical dashed line at x=0 (buy/sell divider)
      const x0 = x.getPixelForValue(0);
      if (x0 >= left && x0 <= right) {
        ctx.save();
        ctx.strokeStyle = 'rgba(88,166,255,0.5)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 4]);
        ctx.beginPath();
        ctx.moveTo(x0, top);
        ctx.lineTo(x0, bottom);
        ctx.stroke();
        // Labels at top
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(248,81,73,0.7)';
        ctx.fillText('買 →', x0 + 8, top + 16);
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(63,185,80,0.7)';
        ctx.fillText('← 賣', x0 - 8, top + 16);
        ctx.restore();
      }

      // Horizontal dashed line at close price
      if (closePrice > 0) {
        const yClose = y.getPixelForValue(closePrice);
        if (yClose >= top && yClose <= bottom) {
          ctx.save();
          ctx.strokeStyle = 'rgba(255,200,55,0.6)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 3]);
          ctx.beginPath();
          ctx.moveTo(left, yClose);
          ctx.lineTo(right, yClose);
          ctx.stroke();
          // Label with background
          const label = '收盤 $' + closePrice;
          ctx.font = 'bold 10px sans-serif';
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = 'rgba(13,17,23,0.8)';
          ctx.fillRect(right - tw - 8, yClose - 14, tw + 6, 16);
          ctx.fillStyle = 'rgba(255,200,55,0.9)';
          ctx.textAlign = 'right';
          ctx.fillText(label, right - 4, yClose - 2);
          ctx.restore();
        }
      }

      // Only label top 3 buyers + top 3 sellers, with collision avoidance
      const placed = []; // track placed label rects
      chart.data.datasets.forEach((ds, di) => {
        const meta = chart.getDatasetMeta(di);
        const limit = Math.min(3, ds.data.length);
        for (let i = 0; i < limit; i++) {
          const el = meta.data[i];
          const raw = ds.data[i];
          if (!el) continue;
          ctx.save();
          const name = raw.label.length > 4 ? raw.label.substring(0, 4) : raw.label;
          ctx.font = 'bold 9px sans-serif';
          const tw = ctx.measureText(name).width;
          let tx = el.x;
          let ty = el.y - raw.r - 4;
          // Nudge if overlapping previous labels
          const rect = () => ({ x: tx - tw/2 - 3, y: ty - 11, w: tw + 6, h: 13 });
          const overlaps = (r) => placed.some(p =>
            r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y
          );
          let r = rect();
          for (let nudge = 0; nudge < 4 && overlaps(r); nudge++) {
            ty -= 14; // push up
            r = rect();
          }
          placed.push(r);
          // Dark pill bg
          ctx.fillStyle = 'rgba(13,17,23,0.8)';
          ctx.beginPath();
          ctx.roundRect(r.x, r.y, r.w, r.h, 3);
          ctx.fill();
          ctx.fillStyle = '#e6edf3';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(name, tx, ty);
          ctx.restore();
        }
      });
    }
  };

  new Chart(ctx, {
    type: 'bubble',
    data: {
      datasets: [
        {
          label: '買超券商',
          data: buyData,
          backgroundColor: function(ctx) {
            const r = ctx.raw ? ctx.raw.r : 5;
            const alpha = Math.min(0.75, 0.3 + r / 30);
            return 'rgba(248,81,73,' + alpha + ')';
          },
          borderColor: 'rgba(248,81,73,0.8)',
          borderWidth: 1.5,
          hoverBackgroundColor: 'rgba(248,81,73,0.9)',
          hoverBorderColor: '#fff',
          hoverBorderWidth: 2,
        },
        {
          label: '賣超券商',
          data: sellData,
          backgroundColor: function(ctx) {
            const r = ctx.raw ? ctx.raw.r : 5;
            const alpha = Math.min(0.75, 0.3 + r / 30);
            return 'rgba(63,185,80,' + alpha + ')';
          },
          borderColor: 'rgba(63,185,80,0.8)',
          borderWidth: 1.5,
          hoverBackgroundColor: 'rgba(63,185,80,0.9)',
          hoverBorderColor: '#fff',
          hoverBorderWidth: 2,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 1.5,
      animation: {
        duration: 800,
        easing: 'easeOutQuart'
      },
      plugins: {
        legend: {
          labels: {
            color: '#8b949e',
            font: { size: 11 },
            usePointStyle: true,
            pointStyle: 'circle',
          }
        },
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
          border: { color: '#30363d' }
        },
        y: {
          title: { display: true, text: '成交均價', color: '#8b949e', font: { size: 11 } },
          grid: { color: 'rgba(33,38,45,0.6)', lineWidth: 0.5 },
          ticks: { color: '#8b949e', font: { size: 10 } },
          border: { color: '#30363d' }
        }
      }
    },
    plugins: [refLinePlugin]
  });
})();
`;
}

function generateStockPage(stockInfo, brokerData, date) {
  const adDate = formatDate(date);
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

  const buyerRows = (brokerData.top_buyers || []).map(b => brokerRow(b, true)).join("");
  const sellerRows = (brokerData.top_sellers || []).map(b => brokerRow(b, false)).join("");

  const tableHead = `<thead><tr><th>券商</th><th>買超</th><th>買均</th><th>買張</th><th>賣張</th><th>賣均</th></tr></thead>`;

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
<div class="container wide">
  <a href="../index.html" class="back">← 返回漲停總覽</a>

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

  <p style="color:#8b949e;font-size:13px;margin-bottom:12px;">共 ${brokerData.total_brokers} 家券商交易</p>

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

  ${generateBubbleChart(brokerData, stockInfo)}

  <footer>
    <p>資料來源：台灣證券交易所公開資訊</p>
    <p><a href="../index.html">烏薩奇漲停版</a> &copy; 2026 | 每日盤後更新</p>
  </footer>
</div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<script>
${generateBubbleChartScript(brokerData, stockInfo)}
</script>
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
