import { query } from '@anthropic-ai/claude-agent-sdk';

console.log('Testing JSON generation...');

const sdkOptions = {
  settingSources: ['project', 'user'],
  model: 'claude-opus-4-20250514',
  maxTurns: 3,
  workingDirectory: process.cwd()
};

const cleanEnv = { ...process.env };
delete cleanEnv.CLAUDECODE;
sdkOptions.env = cleanEnv;

const jsonPrompt = `請將以下股票按產業分組，回傳JSON格式：

股票：
2330 台積電
2454 聯發科
6505 台塑化

格式：
{
  "半導體": ["2330", "2454"],
  "石化": ["6505"]
}

只回傳JSON，不要其他說明。`;

try {
  console.log('Testing JSON prompt...');
  let finalResult = '';
  const conversation = query({ prompt: jsonPrompt, options: sdkOptions });

  let messageCount = 0;
  for await (const message of conversation) {
    messageCount++;
    console.log(`Message ${messageCount}: type=${message.type}`);

    if (message.type === 'result') {
      finalResult = (message.result || '').trim();
      console.log('Raw result:');
      console.log(finalResult);
      break;
    }
  }

  if (finalResult) {
    console.log('\n✅ Got result, testing JSON parse...');
    try {
      const parsed = JSON.parse(finalResult);
      console.log('✅ JSON parse successful:', parsed);
    } catch (parseError) {
      console.log('❌ JSON parse failed:', parseError.message);

      // Test the same parsing logic as claude-classifier
      let cleanedResult = finalResult.trim();
      cleanedResult = cleanedResult.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      cleanedResult = cleanedResult.replace(/^```\s*/, '').replace(/\s*```$/, '');
      const jsonMatch = cleanedResult.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        cleanedResult = jsonMatch[0];
        console.log('Extracted JSON:', cleanedResult);
        try {
          const parsed2 = JSON.parse(cleanedResult);
          console.log('✅ Extracted JSON parse successful:', parsed2);
        } catch (parseError2) {
          console.log('❌ Extracted JSON parse also failed:', parseError2.message);
        }
      }
    }
  } else {
    console.log('❌ No result');
  }
} catch (error) {
  console.log('❌ Error:', error.message);
}