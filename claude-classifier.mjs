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

    const prompt = `你是台股分析專家，請分析今日漲停股票的共同原因並智能分組。

今日漲停股清單（${Object.keys(stocks).length}檔）：
${stockList}

分析要點：
1. 找出可能的漲停主因：產業政策、國際情勢、原物料價格、AI科技趨勢、財報利多、技術面突破等
2. 觀察股票名稱規律：如「欣」字輩（天然氣）、「化」字尾（石化）等
3. 產業關聯性：半導體、生技、金融、傳產等

分組原則：
- 優先以「漲停主因」分組（如天然氣漲價 → 欣字輩集體漲停）
- 每組至少3檔，避免過度分散
- 單獨個股或2檔以下合併為「個股表現」類別

回傳 JSON 格式：
{
  "天然氣概念發威": {
    "icon": "🔥",
    "reason": "天然氣價格大漲，欣字輩概念股集體漲停",
    "stocks": ["8908", "8917", "9918"]
  },
  "石化族群反彈": {
    "icon": "🛢️",
    "reason": "原油反彈帶動石化上游，塑化股同步走強",
    "stocks": ["1309", "6505"]
  }
}

注意：只回傳JSON，代碼必須完全匹配，概念名稱要具體且吸引人。`;

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
    // Try different possible Claude CLI locations
    const possiblePaths = [
      'claude',
      'C:\\Users\\user\\.claude\\claude.exe',
      'C:\\Program Files\\Claude\\claude.exe',
      process.env.CLAUDE_CLI_PATH
    ].filter(Boolean);

    let lastError = null;

    function tryNext(index) {
      if (index >= possiblePaths.length) {
        reject(new Error(`Claude CLI not found. Tried: ${possiblePaths.join(', ')}. Last error: ${lastError?.message}`));
        return;
      }

      const claudePath = possiblePaths[index];
      const claude = spawn(claudePath, ['-q', prompt], {
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
          lastError = new Error(`Claude CLI failed with code ${code}: ${stderr}`);
          tryNext(index + 1);
        }
      });

      claude.on('error', (error) => {
        lastError = error;
        tryNext(index + 1);
      });
    }

    tryNext(0);
  });
}