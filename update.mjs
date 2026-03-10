/**
 * 烏薩奇漲停版 — 一鍵更新
 *
 * 整合：抓漲停清單 → 抓分點資料（TWSE+TPEX）→ 生成網頁
 *
 * Usage:
 *   node update.mjs              ← 完整更新（抓分點 + 生成）
 *   node update.mjs --gen-only   ← 只生成網頁（跳過抓分點）
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const SNAPSHOT_DIR = path.resolve('./snapshots');
const CACHE_DIR = path.resolve('../twse-broker-mcp/cache');
const TWSE_FETCHER = path.resolve('../twse-broker-mcp/fetch_twse_nocaptcha.mjs');
const TPEX_FETCHER = path.resolve('../twse-broker-mcp/fetch_tpex_remaining.mjs');

function getTodayDate() {
  const now = new Date();
  const tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return tw.toISOString().slice(0, 10).replace(/-/g, '');
}

// 動態 import TWSE fetcher
async function fetchTwseBrokerData(codes, date) {
  const { fetchOne } = await import('../twse-broker-mcp/fetch_twse_nocaptcha.mjs');
  let ok = 0;
  for (const code of codes) {
    const success = await fetchOne(code, date);
    if (success) ok++;
    await new Promise(r => setTimeout(r, 500));
  }
  return ok;
}

// 動態 import TPEX fetcher
async function fetchTpexBrokerData(codes, date) {
  const { fetchTpexBatch } = await import('../twse-broker-mcp/tpex_scraper.mjs');
  const results = await fetchTpexBatch(codes, date, 15);
  return Object.keys(results).length;
}

// 分類 TWSE/TPEX
async function classifyMarket(codes) {
  const today = getTodayDate();
  const resp = await axios.get(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json&date=${today}&type=ALL`);
  const twseCodes = new Set();
  if (resp.data.tables) {
    resp.data.tables.forEach(t => {
      if (t.data) t.data.forEach(r => {
        const c = String(r[0]).trim();
        if (/^\d{4}$/.test(c)) twseCodes.add(c);
      });
    });
  }
  return {
    twse: codes.filter(c => twseCodes.has(c)),
    tpex: codes.filter(c => !twseCodes.has(c))
  };
}

async function main() {
  const genOnly = process.argv.includes('--gen-only');

  console.log('🐰 烏薩奇漲停版 — 一鍵更新');
  console.log('');

  if (!genOnly) {
    // Step 1: 確認 snapshot 存在
    const date = getTodayDate();
    const snapshotFile = path.join(SNAPSHOT_DIR, `${date}.json`);

    let snapshotCodes;
    if (fs.existsSync(snapshotFile)) {
      const snap = JSON.parse(fs.readFileSync(snapshotFile, 'utf-8'));
      snapshotCodes = Object.keys(snap);
      console.log(`📋 Snapshot ${date}: ${snapshotCodes.length} stocks`);
    } else {
      console.log(`⚠️  No snapshot for ${date}, running generate first to fetch market data...`);
      // 先跑一次 generate 拿 snapshot（不含分點）
      // generate.mjs 會自動 save snapshot
      console.log('   (This will create a snapshot but broker data will be empty)');
    }

    if (snapshotCodes && snapshotCodes.length > 0) {
      // Step 2: 找出缺分點資料的股票
      const missing = snapshotCodes.filter(c => {
        const cacheFile = path.join(CACHE_DIR, `${c}_${date}.json`);
        return !fs.existsSync(cacheFile);
      });

      if (missing.length === 0) {
        console.log('✅ All broker data already cached');
      } else {
        console.log(`📡 Need to fetch ${missing.length} stocks' broker data...`);

        // 分類
        const { twse, tpex } = await classifyMarket(missing);
        console.log(`   TWSE: ${twse.length}, TPEX: ${tpex.length}`);

        // 抓 TWSE（純 HTTP，無 CAPTCHA）
        if (twse.length > 0) {
          console.log('\n[TWSE] Fetching broker data...');
          const twseOk = await fetchTwseBrokerData(twse, date);
          console.log(`[TWSE] ${twseOk}/${twse.length} OK`);
        }

        // 抓 TPEX（Playwright + Turnstile，會開瀏覽器）
        if (tpex.length > 0) {
          console.log('\n[TPEX] Fetching broker data (browser will open)...');
          try {
            const tpexOk = await fetchTpexBrokerData(tpex, date);
            console.log(`[TPEX] ${tpexOk}/${tpex.length} OK`);
          } catch (e) {
            console.log(`[TPEX] Failed: ${e.message}`);
            console.log('   TPEX requires Playwright + Edge. Run manually if needed.');
          }
        }
      }
    }
  }

  // Step 3: 生成網頁
  console.log('\n📄 Generating website...');
  // 用 dynamic import 而非 exec，避免 subprocess 問題
  await import('./generate.mjs');
}

main().catch(e => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
