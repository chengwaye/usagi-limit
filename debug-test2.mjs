import { query } from '@anthropic-ai/claude-agent-sdk';

console.log('Testing simple prompt first...');

const sdkOptions = {
  settingSources: ['project', 'user'],
  model: 'claude-opus-4-20250514',
  maxTurns: 3, // 增加 maxTurns
  workingDirectory: process.cwd()
};

const cleanEnv = { ...process.env };
delete cleanEnv.CLAUDECODE;
sdkOptions.env = cleanEnv;

// 測試簡單 prompt
const simplePrompt = "請回答：台股代碼 2330 是什麼公司？";

try {
  console.log('Testing simple prompt:', simplePrompt);
  let finalResult = '';
  const conversation = query({ prompt: simplePrompt, options: sdkOptions });

  let messageCount = 0;
  for await (const message of conversation) {
    messageCount++;
    console.log(`Message ${messageCount}: type=${message.type}`);

    if (message.type === 'assistant' || message.type === 'result') {
      console.log('Content:', message.content || message.result || 'empty');
    }

    if (message.type === 'result') {
      finalResult = (message.result || '').trim();
      break;
    }
  }

  console.log('Final result:', finalResult || 'EMPTY');
} catch (error) {
  console.log('❌ Error:', error.message);
}