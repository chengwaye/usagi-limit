/**
 * Improved Claude Stock Classifier
 * 修復間歇性 SDK 連接問題並增強錯誤處理
 */

import fs from 'fs';
import path from 'path';

export async function classifyWithClaude(stocks) {
  try {
    // Prepare stock list for Claude analysis
    const stockList = Object.values(stocks).map(s =>
      `${s.code} ${s.name} (漲${s.changePct}%, 成交量${Math.round(s.volume/10000)}萬)`
    ).join('\n');

    console.log('🤖 Calling Claude for intelligent stock classification...');

    // 簡化並優化 prompt
    const prompt = `你是台股分析專家。請分析這些漲停股並智能分組：

${stockList}

請按產業/主題分組，每組至少2檔。回傳JSON格式：
{
  "概念名稱": {
    "icon": "🔥",
    "reason": "漲停原因",
    "stocks": ["代碼1", "代碼2"]
  }
}

只回傳JSON，不要其他文字。`;

    // Call Claude with improved error handling
    const result = await callClaudeWithRetry(prompt, 3);

    // Parse Claude response - handle various response formats
    const classification = parseClaudeResponse(result);

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

function parseClaudeResponse(result) {
  let cleanedResult = result.trim();

  // Remove markdown code blocks if present
  cleanedResult = cleanedResult.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  cleanedResult = cleanedResult.replace(/^```\s*/, '').replace(/\s*```$/, '');

  // Find JSON part if mixed with other text
  const jsonMatch = cleanedResult.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleanedResult = jsonMatch[0];
  }

  // Try to parse JSON with better error handling
  try {
    return JSON.parse(cleanedResult);
  } catch (parseError) {
    console.log('JSON parse failed, raw response preview:', result.slice(0, 200));
    throw new Error(`JSON parse failed: ${parseError.message}`);
  }
}

async function callClaudeWithRetry(prompt, maxRetries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempt ${attempt}/${maxRetries}...`);
      const result = await callClaude(prompt);

      if (result && result.trim()) {
        return result;
      } else {
        throw new Error("Empty result from Claude Agent SDK");
      }
    } catch (error) {
      lastError = error;
      console.log(`Attempt ${attempt} failed: ${error.message}`);

      if (attempt < maxRetries) {
        // 等待 1 秒後重試
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  throw new Error(`All ${maxRetries} attempts failed. Last error: ${lastError.message}`);
}

async function callClaude(prompt) {
  try {
    // 動態載入 Claude Agent SDK
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    // 優化 SDK 選項
    const sdkOptions = {
      settingSources: ["project", "user"],
      model: "claude-opus-4-20250514",
      maxTurns: 5, // 增加 maxTurns 以防對話被截斷
      workingDirectory: process.cwd()
    };

    // 清理環境變數
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    sdkOptions.env = cleanEnv;

    let finalResult = "";
    const conversation = query({ prompt, options: sdkOptions });

    let messageCount = 0;
    let hasAssistantMessage = false;

    for await (const message of conversation) {
      messageCount++;

      if (message.type === 'assistant') {
        hasAssistantMessage = true;
      }

      if (message.type === "result") {
        finalResult = (message.result || "").trim();
        break;
      }
    }

    // 詳細除錯資訊
    if (!finalResult) {
      const errorMsg = `No result from Claude Agent SDK (${messageCount} messages, hasAssistant: ${hasAssistantMessage})`;
      throw new Error(errorMsg);
    }

    return finalResult;
  } catch (error) {
    throw new Error(`Claude Agent SDK failed: ${error.message}`);
  }
}