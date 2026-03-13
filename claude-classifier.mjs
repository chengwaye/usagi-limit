/**
 * Claude Stock Classifier
 * 優先讀 AI cache（由 NLM 或其他方式預先生成），cache miss 時 fallback 到 claude -p
 */

import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.resolve('./data');

export async function classifyWithClaude(stocks, date) {
  // Step 1: 嘗試讀 cache
  const cacheFile = path.join(CACHE_DIR, `ai-cache-${date}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // 驗證 cache 有 concepts（不是全部 fallback 到「其他強勢」的爛 cache）
      const conceptKeys = Object.keys(cached.concepts || {});
      if (conceptKeys.length > 1 || (conceptKeys.length === 1 && conceptKeys[0] !== '其他強勢')) {
        console.log(`📦 Using AI cache: ${cacheFile} (${conceptKeys.length} groups)`);
        // 把 cache 裡的 stock code 轉回 stock objects
        return hydrateCachedResult(cached, stocks);
      }
      console.log(`⚠️ Cache exists but only has fallback grouping, re-classifying...`);
    } catch (e) {
      console.log(`⚠️ Cache read failed: ${e.message}, re-classifying...`);
    }
  }

  // Step 2: 沒有好的 cache，用 claude -p
  try {
    console.log(`🤖 Calling Claude for classification (${Object.keys(stocks).length} stocks)...`);
    const result = await classifyWithClaudePipe(stocks);
    // 存 cache
    saveCache(cacheFile, result, stocks);
    return result;
  } catch (error) {
    console.log(`❌ Claude classification failed: ${error.message}`);
    throw error;
  }
}

// 把 NLM/外部產生的 cache（stock codes）轉回帶 stock objects 的格式
// 安全網：snapshot 中沒被 AI cache 涵蓋的股票自動歸入「其他強勢」
function hydrateCachedResult(cached, stocks) {
  const processedConcepts = {};
  const coveredCodes = new Set();

  for (const [name, data] of Object.entries(cached.concepts || {})) {
    const stockObjects = (data.stocks || []).map(item => {
      const code = typeof item === 'string' ? item : item.code;
      return Object.values(stocks).find(s => s.code === code);
    }).filter(Boolean);

    for (const s of stockObjects) coveredCodes.add(s.code);

    if (stockObjects.length > 0) {
      processedConcepts[name] = {
        icon: data.icon,
        reason: data.reason,
        stocks: stockObjects
      };
    }
  }

  // 安全網：未被 AI cache 涵蓋的股票自動歸入「其他強勢」
  const uncovered = Object.values(stocks).filter(s => !coveredCodes.has(s.code));
  if (uncovered.length > 0) {
    console.log(`⚠️ ${uncovered.length} stocks not in AI cache, auto-adding to 其他強勢: ${uncovered.map(s => s.code).join(', ')}`);
    if (processedConcepts['其他強勢']) {
      processedConcepts['其他強勢'].stocks.push(...uncovered);
    } else {
      processedConcepts['其他強勢'] = {
        icon: '🔥',
        reason: '大盤震盪中逆勢表態的中小型個股，包含各類題材與短線資金輪動標的。',
        stocks: uncovered
      };
    }
  }

  // stockReasons: 保持原樣 + 自動補缺
  const stockReasons = {};
  for (const [code, val] of Object.entries(cached.stockReasons || {})) {
    if (typeof val === 'string') {
      stockReasons[code] = { reason: val, category: '市場', confidence: 'medium' };
    } else {
      stockReasons[code] = val;
    }
  }
  for (const s of uncovered) {
    if (!stockReasons[s.code]) {
      stockReasons[s.code] = { reason: '大盤震盪中逆勢表態，短線資金輪動標的。', category: '其他強勢', confidence: 'low' };
    }
  }

  return { concepts: processedConcepts, stockReasons };
}

// 存 cache（stock objects 轉成 codes 以節省空間）
function saveCache(cacheFile, result, stocks) {
  try {
    const toSave = {
      concepts: {},
      stockReasons: result.stockReasons || {}
    };
    for (const [name, data] of Object.entries(result.concepts || {})) {
      toSave.concepts[name] = {
        icon: data.icon,
        reason: data.reason,
        stocks: (data.stocks || []).map(s => typeof s === 'string' ? s : s.code)
      };
    }
    fs.writeFileSync(cacheFile, JSON.stringify(toSave, null, 2), 'utf8');
    console.log(`💾 Saved AI cache: ${cacheFile}`);
  } catch (e) {
    console.log(`⚠️ Cache save failed: ${e.message}`);
  }
}

// Fallback: claude -p 分批分類
async function classifyWithClaudePipe(stocks) {
  const stockArray = Object.values(stocks);
  const BATCH_SIZE = 10;
  const batches = [];
  for (let i = 0; i < stockArray.length; i += BATCH_SIZE) {
    batches.push(stockArray.slice(i, i + BATCH_SIZE));
  }

  console.log(`  分 ${batches.length} 批，每批 ${BATCH_SIZE} 檔`);

  // Step 1: 分批取個股原因
  const allReasons = {};
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const stockList = batch.map(s =>
      `${s.code} ${s.name} (漲${s.changePct}%, 成交量${Math.round(s.volume/10000)}萬)`
    ).join('\n');

    console.log(`  📊 批次 ${i+1}/${batches.length} (${batch.length} 檔)...`);

    const today = new Date().toISOString().slice(0, 10);
    const prompt = `你是台股分析專家。今天是 ${today}。以下是今天的漲停股：
${stockList}

請先搜尋每檔股票近 3 天的最新新聞與公告，再分析漲停原因（2-3句話），需包含：
1. 近期新聞事件：法說會內容、財報/營收公布（務必提及具體數字如營收YoY、EPS）、法人調升目標價、獲得大單等
2. 產業背景或族群連動原因
3. 是否有特定題材（AI、HBM、CoWoS、新品、併購、庫藏股、除權息等）

⚠️ 時效性最重要！優先引用今天或昨天的新聞，不要用過時資訊。如果找不到近期新聞，confidence 請標 low。

回傳JSON（只要JSON）：
{
  "stockReasons": {
    "2408": { "reason": "2-3句詳細原因，含具體新聞事件與數字", "category": "分類", "confidence": "high/medium/low" }
  }
}`;

    const result = await callClaudeWithRetry(prompt, 3);
    const parsed = parseClaudeResponse(result);
    const reasons = parsed.stockReasons || parsed;

    for (const [code, val] of Object.entries(reasons)) {
      allReasons[code] = typeof val === 'string'
        ? { reason: val, category: '市場', confidence: 'medium' }
        : val;
    }

    console.log(`  ✓ 批次 ${i+1} 完成，累計 ${Object.keys(allReasons).length} 檔`);
    if (i < batches.length - 1) await new Promise(r => setTimeout(r, 3000));
  }

  // Step 2: 統一分組
  console.log(`  🔄 統一分組 (${Object.keys(allReasons).length} 檔)...`);

  const reasonSummary = Object.entries(allReasons).map(([code, r]) => {
    const stock = Object.values(stocks).find(s => s.code === code);
    return `${code} ${stock?.name || ''}: ${r.reason} [${r.category}]`;
  }).join('\n');

  const groupPrompt = `你是台股分析專家。以下是今天漲停股的個別原因：
${reasonSummary}

請根據原因的相似性，將股票分組（每組至少2檔，落單的歸「其他強勢」）。
回傳JSON（只要JSON）：
{
  "concepts": {
    "AI/伺服器": { "icon": "🤖", "reason": "概念說明", "stocks": ["2408", "3006"] }
  }
}`;

  const groupResult = await callClaudeWithRetry(groupPrompt, 3);
  const groupParsed = parseClaudeResponse(groupResult);
  const rawConcepts = groupParsed.concepts || groupParsed;

  const processedConcepts = {};
  for (const [name, data] of Object.entries(rawConcepts)) {
    if (name === 'stockReasons') continue;
    const stockObjects = (data.stocks || []).map(code =>
      Object.values(stocks).find(s => s.code === code)
    ).filter(Boolean);
    if (stockObjects.length > 0) {
      processedConcepts[name] = { icon: data.icon, reason: data.reason, stocks: stockObjects };
    }
  }

  console.log(`✅ Claude classified ${Object.keys(processedConcepts).length} groups, ${Object.keys(allReasons).length} reasons`);
  return { concepts: processedConcepts, stockReasons: allReasons };
}

function parseClaudeResponse(result) {
  let cleaned = result.trim();
  cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) cleaned = jsonMatch[0];
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.log('JSON parse failed, preview:', result.slice(0, 200));
    throw new Error(`JSON parse failed: ${e.message}`);
  }
}

async function callClaudeWithRetry(prompt, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await callClaude(prompt);
      if (result?.trim()) return result;
      throw new Error('Empty result');
    } catch (error) {
      lastError = error;
      console.log(`    ✗ Attempt ${attempt} failed: ${error.message}`);
      if (attempt < maxRetries) {
        const wait = attempt * 3000;
        console.log(`    Waiting ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw new Error(`All ${maxRetries} attempts failed: ${lastError.message}`);
}

async function callClaude(prompt) {
  const startTime = Date.now();
  const { spawn } = await import('child_process');

  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.TELEGRAM_BOT_TOKEN;

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', [
      '-p', '--model', 'claude-sonnet-4-20250514', '--output-format', 'text'
    ], { env: cleanEnv });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.stdin.write(prompt);
    proc.stdin.end();

    const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout 120s')); }, 120000);

    proc.on('close', code => {
      clearTimeout(timer);
      const result = stdout.trim();
      const elapsed = Date.now() - startTime;
      if (code !== 0) { reject(new Error(`exit ${code}: ${stderr.slice(0, 200)}`)); return; }
      if (!result) { reject(new Error('Empty result')); return; }
      console.log(`    ✓ claude -p ${elapsed}ms (${result.length} chars)`);
      resolve(result);
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}
