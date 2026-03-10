/**
 * FinLab 券商分點資料載入器
 * 將 FinLab broker_transactions.csv 資料轉換為 usagi-limit 格式
 * 使用 streaming 方式處理大檔案 (6.9GB)
 */

import fs from "fs";
import path from "path";
import { createReadStream } from "fs";
import { createInterface } from "readline";

const FINLAB_DATA_DIR = path.resolve("../finlab-data");
const BROKER_TRANSACTIONS_FILE = path.join(FINLAB_DATA_DIR, "broker_transactions.csv");

// 日期範圍的券商資料緩存
const dateRangeCache = new Map();

/**
 * 載入特定日期範圍的 FinLab 券商分點資料 (streaming)
 * @param {string} startDate - 開始日期 (YYYY-MM-DD)
 * @param {string} endDate - 結束日期 (YYYY-MM-DD)
 * @returns {Promise<Object>} - 按日期索引的資料
 */
async function loadFinLabBrokerDataRange(startDate, endDate) {
  const cacheKey = `${startDate}_${endDate}`;
  if (dateRangeCache.has(cacheKey)) {
    return dateRangeCache.get(cacheKey);
  }

  if (!fs.existsSync(BROKER_TRANSACTIONS_FILE)) {
    console.log("Warning: FinLab broker_transactions.csv not found");
    return null;
  }

  console.log(`Loading FinLab broker data for ${startDate} to ${endDate}...`);

  const brokerData = {};
  let lineCount = 0;
  let matchedLines = 0;

  try {
    const fileStream = createReadStream(BROKER_TRANSACTIONS_FILE);
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let isFirstLine = true;

    for await (const line of rl) {
      lineCount++;

      if (isFirstLine) {
        isFirstLine = false;
        continue; // 跳過標題行
      }

      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      // 解析 CSV 行（注意可能有逗號在券商名稱中）
      const values = trimmedLine.split(',');
      if (values.length < 6) continue;

      const date = values[1]; // YYYY-MM-DD
      const stockId = values[2];
      const broker = values[3];
      const buy = parseInt(values[4]) || 0;
      const sell = parseInt(values[5]) || 0;

      // 檢查日期是否在範圍內
      if (date >= startDate && date <= endDate) {
        matchedLines++;

        // 轉換日期格式：YYYY-MM-DD → YYYYMMDD
        const dateKey = date.replace(/-/g, "");

        // 建立索引結構
        if (!brokerData[dateKey]) {
          brokerData[dateKey] = {};
        }
        if (!brokerData[dateKey][stockId]) {
          brokerData[dateKey][stockId] = [];
        }

        brokerData[dateKey][stockId].push({
          broker_name: broker,
          buy_volume: buy,
          sell_volume: sell,
          net_volume: buy - sell
        });
      }

      // 每 100 萬行顯示進度
      if (lineCount % 1000000 === 0) {
        console.log(`Processed ${lineCount / 1000000}M lines, found ${matchedLines} matches`);
      }
    }

    console.log(`✅ Loaded ${matchedLines} records from ${Object.keys(brokerData).length} trading days`);
    dateRangeCache.set(cacheKey, brokerData);
    return brokerData;

  } catch (error) {
    console.error("Error loading FinLab broker data:", error);
    return null;
  }
}

/**
 * 從 FinLab 資料中載入特定股票和日期的券商分點資料
 * @param {string} stockCode - 股票代碼
 * @param {string} date - 日期 (YYYYMMDD)
 * @returns {Promise<object|null>} - 轉換後的券商分點資料，格式與 cache 檔案相同
 */
export async function loadFinLabBrokerDataForStock(stockCode, date) {
  // 轉換日期格式：YYYYMMDD → YYYY-MM-DD
  const formattedDate = `${date.substr(0, 4)}-${date.substr(4, 2)}-${date.substr(6, 2)}`;

  // 計算搜尋範圍（目標日期前後5天，避免載入過多資料）
  const targetDate = new Date(formattedDate);
  const startDate = new Date(targetDate);
  startDate.setDate(targetDate.getDate() - 5);
  const endDate = new Date(targetDate);
  endDate.setDate(targetDate.getDate() + 1);

  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = endDate.toISOString().split('T')[0];

  const brokerData = await loadFinLabBrokerDataRange(startDateStr, endDateStr);
  if (!brokerData) {
    return null;
  }

  // 嘗試精確匹配
  if (brokerData[date] && brokerData[date][stockCode]) {
    return formatBrokerDataForUsagiLimit(stockCode, date, brokerData[date][stockCode]);
  }

  // Fallback: 尋找最近的過去資料（≤ date，最多5天差距）
  const dateInt = parseInt(date);
  const availableDates = Object.keys(brokerData)
    .filter(d => {
      const dInt = parseInt(d);
      return dInt <= dateInt && (dateInt - dInt) <= 5;
    })
    .sort((a, b) => parseInt(b) - parseInt(a)); // 降序，最新的在前

  for (const availableDate of availableDates) {
    if (brokerData[availableDate] && brokerData[availableDate][stockCode]) {
      console.log(`Using FinLab broker data from ${availableDate} for ${stockCode} (requested: ${date})`);
      return formatBrokerDataForUsagiLimit(stockCode, availableDate, brokerData[availableDate][stockCode]);
    }
  }

  return null;
}

/**
 * 將 FinLab 券商資料轉換為 usagi-limit 期待的格式
 * @param {string} stockCode - 股票代碼
 * @param {string} date - 日期
 * @param {array} brokerRecords - FinLab 券商記錄
 * @returns {object} - usagi-limit 格式的資料
 */
function formatBrokerDataForUsagiLimit(stockCode, date, brokerRecords) {
  // 計算買進排行和賣出排行
  const buyRanking = [...brokerRecords]
    .filter(record => record.buy_volume > 0)
    .sort((a, b) => b.buy_volume - a.buy_volume)
    .slice(0, 15); // 前15大

  const sellRanking = [...brokerRecords]
    .filter(record => record.sell_volume > 0)
    .sort((a, b) => b.sell_volume - a.sell_volume)
    .slice(0, 15); // 前15大

  const netBuyRanking = [...brokerRecords]
    .filter(record => record.net_volume > 0)
    .sort((a, b) => b.net_volume - a.net_volume)
    .slice(0, 15); // 前15大買超

  const netSellRanking = [...brokerRecords]
    .filter(record => record.net_volume < 0)
    .sort((a, b) => a.net_volume - b.net_volume) // 負數排序
    .slice(0, 15); // 前15大賣超

  return {
    stock_id: stockCode,
    date: date,
    total_brokers: brokerRecords.length,
    data_source: "finlab",
    top_buyers: buyRanking,
    top_sellers: sellRanking,
    top_net_buyers: netBuyRanking,
    top_net_sellers: netSellRanking
  };
}