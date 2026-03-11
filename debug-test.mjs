import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'fs';

console.log('Debug: Testing with actual classification prompt...');

const stocks = JSON.parse(fs.readFileSync('./snapshots/20260309.json', 'utf8'));
const stockList = Object.values(stocks).map(s =>
  `${s.code} ${s.name} (漲${s.changePct}%, 成交量${Math.round(s.volume/10000)}萬)`
).join('\n');

const prompt = `你是台股分析專家，請分析今日漲停股票的共同原因並智能分組。

今日漲停股清單（${Object.keys(stocks).length}檔）：
${stockList}

回傳 JSON 格式：
{
  "概念名稱": {
    "icon": "🔥",
    "reason": "漲停原因說明",
    "stocks": ["股票代碼"]
  }
}

注意：只回傳JSON，代碼必須完全匹配。`;

console.log('Stock list:');
console.log(stockList);
console.log('\nPrompt length:', prompt.length);

const sdkOptions = {
  settingSources: ['project', 'user'],
  model: 'claude-opus-4-20250514',
  maxTurns: 1,
  workingDirectory: process.cwd()
};

const cleanEnv = { ...process.env };
delete cleanEnv.CLAUDECODE;
sdkOptions.env = cleanEnv;

try {
  console.log('\nStarting conversation...');
  let finalResult = '';
  const conversation = query({ prompt, options: sdkOptions });

  console.log('Iterating messages...');
  let messageCount = 0;
  for await (const message of conversation) {
    messageCount++;
    console.log(`Message ${messageCount}: type=${message.type}`);

    if (message.type === 'result') {
      finalResult = (message.result || '').trim();
      console.log('Got result, length:', finalResult.length);
      console.log('Result:', finalResult);
      break;
    }
  }

  if (!finalResult) {
    console.log('❌ No result found after', messageCount, 'messages');
  } else {
    console.log('✅ Got result successfully');
  }
} catch (error) {
  console.log('❌ Error during conversation:', error.message);
}