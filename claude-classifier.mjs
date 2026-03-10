/**
 * Claude Stock Classifier
 * 使用 Claude API 智能分析漲停股概念分組
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export async function classifyWithClaude(stocks) {
  try {
    // Prepare stock list for Claude analysis
    const stockList = Object.values(stocks).map(s =>
      `${s.code} ${s.name} (漲${s.changePct}%, 成交量${Math.round(s.volume/10000)}萬)`
    ).join('\n');

    console.log('🤖 Calling Claude for intelligent stock classification...');

    const prompt = `分析今日這些漲停股，根據漲停原因智能分組。請回傳 JSON 格式：

漲停股清單：
${stockList}

請分析每檔股票可能的漲停原因（如AI熱潮、原物料上漲、政策利多、財報佳、技術面突破等），將相同概念的股票歸類一組。

回傳格式：
{
  "概念名稱1": {
    "icon": "🤖",
    "reason": "簡短說明漲停原因",
    "stocks": ["2330", "2454"]
  },
  "概念名稱2": {
    "icon": "🛢️",
    "reason": "簡短說明漲停原因",
    "stocks": ["6505", "1314"]
  }
}

要求：
1. 概念名稱要具體（如"AI晶片熱潮"而非"科技股"）
2. 每組至少2檔股票，除非某股票獨特性很強
3. 選擇合適的 emoji 圖示
4. 只回傳 JSON，不要其他文字
5. 股票代碼必須完全匹配清單中的代碼`;

    // Call Claude via claude_cli (similar to telegram worker)
    const result = await callClaude(prompt);

    // Parse Claude response
    const cleanedResult = result.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
    const classification = JSON.parse(cleanedResult);

    // Convert to our expected format
    const processedConcepts = {};
    for (const [conceptName, conceptData] of Object.entries(classification)) {
      const stockObjects = conceptData.stocks.map(code =>
        Object.values(stocks).find(s => s.code === code)
      ).filter(Boolean);

      if (stockObjects.length > 0) {
        processedConcepts[conceptName] = {
          icon: conceptData.icon,
          reason: conceptData.reason,
          stocks: stockObjects
        };
      }
    }

    console.log(`✅ Claude classified ${Object.keys(processedConcepts).length} concept groups`);
    return processedConcepts;

  } catch (error) {
    console.log(`❌ Claude classification failed: ${error.message}`);
    throw error;
  }
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const claude = spawn('claude', ['-q', prompt], {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: process.env
    });

    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    claude.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    claude.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Claude CLI failed with code ${code}: ${stderr}`));
      }
    });

    claude.on('error', (error) => {
      reject(new Error(`Failed to spawn Claude CLI: ${error.message}`));
    });
  });
}