import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const base = { NAPCAT_WS_URL: 'ws://localhost:3001', TARGET_TYPE: 'group', TARGET_ID: '9007199254740993' };

test('配置保留字符串 ID 和概率边界', () => {
  const config = loadConfig(base);
  assert.equal(config.target.id, base.TARGET_ID);
  assert.equal(config.randomReplyProbability, 0.05);
  assert.equal(config.allowCommands, false);
  assert.equal(config.allowFileWrites, true);
  assert.equal(config.agentApi, 'openai-responses');
  assert.equal(config.agentMaxOutputTokens, 8192);
  assert.equal(config.agentModel, undefined);
  assert.equal(config.agentBaseUrl, undefined);
  assert.equal(config.agentApiKey, undefined);
  assert.equal(config.agentReasoning, undefined);
  assert.equal(config.agentContextWindow, 200000);
  assert.equal(config.agentCompactLimit, 160000);
  assert.deepEqual(config.webSearch, { provider: 'none' });
  assert.deepEqual(config.tts, { provider: 'none' });
  assert.equal(config.voiceReplyEnabled, false);
  assert.equal(config.voiceReplyProbability, 0.2);
  for (const probability of ['0', '1']) assert.equal(loadConfig({ ...base, RANDOM_REPLY_PROBABILITY: probability }).randomReplyProbability, Number(probability));
});

test('语音开关和供应商独立配置，概率仅在开启时校验并生效', () => {
  const selected = loadConfig({ ...base, TTS_PROVIDER: 'edge-tts' });
  assert.equal(selected.tts.provider, 'edge-tts');
  assert.equal(selected.voiceReplyEnabled, false);
  for (const value of ['0', '0.2', '1']) {
    const config = loadConfig({ ...base, TTS_PROVIDER: 'edge-tts', VOICE_REPLY_ENABLED: 'true', VOICE_REPLY_PROBABILITY: value });
    assert.equal(config.voiceReplyEnabled, true);
    assert.equal(config.voiceReplyProbability, Number(value));
  }
  assert.equal(loadConfig({ ...base, VOICE_REPLY_PROBABILITY: 'unused-invalid-value' }).voiceReplyProbability, 0.2);
  assert.equal(loadConfig({ ...base, TTS_PROVIDER: 'edge-tts', VOICE_REPLY_ENABLED: 'true' }).voiceReplyProbability, 0.2);
  assert.throws(() => loadConfig({ ...base, VOICE_REPLY_ENABLED: 'true' }), /TTS_PROVIDER/);
  for (const value of ['', '1', 'yes', 'FALSE', 'private-secret']) {
    assert.throws(() => loadConfig({ ...base, VOICE_REPLY_ENABLED: value }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /VOICE_REPLY_ENABLED/);
      assert.doesNotMatch(error.message, /private-secret/);
      return true;
    });
  }
  for (const value of ['', ' ', '-0.1', '1.1', 'NaN', 'Infinity', 'private-secret']) {
    assert.throws(() => loadConfig({ ...base, TTS_PROVIDER: 'edge-tts', VOICE_REPLY_ENABLED: 'true', VOICE_REPLY_PROBABILITY: value }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /VOICE_REPLY_PROBABILITY/);
      assert.doesNotMatch(error.message, /private-secret/);
      return true;
    });
  }
});

test('加载桥接配置时验证并传递选中的搜索供应商', () => {
  const config = loadConfig({ ...base,
    WEB_SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'fake-test-key-search-config',
    TAVILY_SEARCH_BASE_URL: 'https://search.example.com/gateway/', TAVILY_SEARCH_DEPTH: 'advanced',
    TAVILY_MAX_RESULTS: '7', WEB_SEARCH_TIMEOUT_MS: '12001',
  });
  assert.deepEqual(config.webSearch, { provider: 'tavily', apiKey: 'fake-test-key-search-config',
    baseUrl: 'https://search.example.com/gateway', searchDepth: 'advanced', maxResults: 7, timeoutMs: 12001 });
  assert.throws(() => loadConfig({ ...base, WEB_SEARCH_PROVIDER: 'tavily' }), /TAVILY_API_KEY/);
});

test('桥接配置可选择 MiMo 并保留语音开关、概率及独立朗读风格', () => {
  const style = '清亮柔和，稍微俏皮。\n保持自然。';
  const config = loadConfig({ ...base, TTS_PROVIDER: 'mimo', MIMO_TTS_API_KEY: 'fake-mimo-config-key',
    MIMO_TTS_VOICE: '冰糖', MIMO_TTS_STYLE: style, VOICE_REPLY_ENABLED: 'true', VOICE_REPLY_PROBABILITY: '1' });
  assert.equal(config.tts.provider, 'mimo');
  if (config.tts.provider !== 'mimo') assert.fail('MiMo provider required');
  assert.equal(config.tts.voice, '冰糖');
  assert.equal(config.tts.style, style);
  assert.equal(config.voiceReplyEnabled, true);
  assert.equal(config.voiceReplyProbability, 1);
  assert.equal(config.agentModel, undefined);
  assert.throws(() => loadConfig({ ...base, TTS_PROVIDER: 'mimo' }), /MIMO_TTS_API_KEY/);
});

test('第三方模型配置保留自定义路径并规范化 URL', () => {
  const config = loadConfig({
    ...base,
    AGENT_BASE_URL: ' https://API.example.com:443/gateway/v1/ ',
    AGENT_MODEL: ' custom-model ',
    AGENT_API_KEY: '  private-key  ',
    AGENT_REASONING: ' high ',
  });
  assert.equal(config.agentBaseUrl, 'https://api.example.com/gateway/v1');
  assert.equal(config.agentModel, 'custom-model');
  assert.equal(config.agentApiKey, '  private-key  ');
  assert.equal(config.agentReasoning, 'high');
});

test('空字符串保留空模型配置与显式的上下文默认值', () => {
  for (const blank of ['', ' \t\n ']) {
    const config = loadConfig({
      ...base,
      AGENT_BASE_URL: blank,
      AGENT_MODEL: blank,
      AGENT_API_KEY: blank,
      AGENT_REASONING: blank,
      AGENT_CONTEXT_WINDOW: blank,
      AGENT_AUTO_COMPACT_TOKEN_LIMIT: blank,
    });
    assert.equal(config.agentBaseUrl, undefined);
    assert.equal(config.agentModel, undefined);
    assert.equal(config.agentApiKey, undefined);
    assert.equal(config.agentReasoning, undefined);
    assert.equal(config.agentContextWindow, 200000);
    assert.equal(config.agentCompactLimit, 160000);
  }
});

test('上下文窗口、压缩阈值和最大输出共同验证预留空间', () => {
  const config = loadConfig({ ...base, AGENT_CONTEXT_WINDOW: '128000', AGENT_AUTO_COMPACT_TOKEN_LIMIT: '100000', AGENT_MAX_OUTPUT_TOKENS: '12000' });
  assert.equal(config.agentContextWindow, 128000);
  assert.equal(config.agentCompactLimit, 100000);
  assert.equal(config.agentMaxOutputTokens, 12000);
  assert.throws(() => loadConfig({ ...base, AGENT_AUTO_COMPACT_TOKEN_LIMIT: '200000' }), /必须小于/u);
  assert.throws(() => loadConfig({ ...base, AGENT_MAX_OUTPUT_TOKENS: '40001' }), /预留量/u);
  assert.equal(loadConfig({ ...base, AGENT_MAX_OUTPUT_TOKENS: '40000' }).agentMaxOutputTokens, 40000);
});

test('无效上下文窗口和自动压缩阈值在启动前失败且不回显配置值', () => {
  for (const name of ['AGENT_CONTEXT_WINDOW', 'AGENT_AUTO_COMPACT_TOKEN_LIMIT']) {
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', 'private-secret']) {
      assert.throws(() => loadConfig({ ...base, [name]: value }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, `${name} 必须为正的安全整数`);
        assert.doesNotMatch(error.message, /private-secret|9007199254740992/);
        return true;
      });
    }
  }
});

test('第三方服务允许 HTTP 和无鉴权访问', () => {
  for (const [input, expected] of [
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
    ['https://example.com', 'https://example.com'],
    ['http://[::1]:8080/v1/', 'http://[::1]:8080/v1'],
  ]) {
    const config = loadConfig({ ...base, AGENT_BASE_URL: input, AGENT_MODEL: 'local-model' });
    assert.equal(config.agentBaseUrl, expected);
    assert.equal(config.agentApiKey, undefined);
  }
});

test('第三方地址在连接前校验且错误不泄露地址或凭据', () => {
  for (const address of [
    'not-a-url-super-secret', 'file:///super-secret', 'ftp://secret.example/v1',
    'https://user:super-secret@secret.example/v1', 'https://secret.example/v1?key=super-secret',
    'https://secret.example/v1#super-secret', 'https://secret.example/v1?', 'https://secret.example/v1#',
    'https://',
  ]) {
    assert.throws(() => loadConfig({
      ...base, AGENT_BASE_URL: address, AGENT_MODEL: 'custom-model', AGENT_API_KEY: 'api-super-secret',
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /AGENT_BASE_URL/);
      assert.doesNotMatch(error.message, /super-secret|secret\.example|user:/);
      return true;
    });
  }
});

test('设置第三方地址必须显式指定模型', () => {
  for (const model of [undefined, '', ' \t ']) {
    assert.throws(() => loadConfig({ ...base, AGENT_BASE_URL: 'https://secret.example/v1', AGENT_MODEL: model }), {
      message: '设置 AGENT_BASE_URL 时必须同时设置 AGENT_MODEL',
    });
  }
});

test('未设置 Base URL 时保留配置，不猜测默认供应商', () => {
  const config = loadConfig({ ...base, AGENT_API_KEY: 'native-provider-key', AGENT_MODEL: 'native-model' });
  assert.equal(config.agentApiKey, 'native-provider-key');
  assert.equal(config.agentModel, 'native-model');
  assert.equal(config.agentBaseUrl, undefined);
});

test('思考等级可独立配置全部已知等级', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const config = loadConfig({ ...base, AGENT_REASONING: effort });
    assert.equal(config.agentReasoning, effort);
    assert.equal(config.agentBaseUrl, undefined);
  }
});

test('无效思考等级在启动前失败且不回显配置值', () => {
  for (const effort of ['HIGH', 'automatic', 'ultra', 'private-secret']) {
    assert.throws(() => loadConfig({ ...base, AGENT_REASONING: effort }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /AGENT_REASONING/);
      assert.doesNotMatch(error.message, /HIGH|automatic|private-secret/);
      return true;
    });
  }
});

test('配置错误在连接前失败且不泄露 URL 或 token', () => {
  for (const patch of [
    { TARGET_TYPE: 'both' }, { TARGET_ID: '0' }, { TARGET_ID: '1 OR 1=1' },
    { NAPCAT_WS_URL: 'https://secret.example' }, { NAPCAT_WS_URL: 'ws://user:secret@localhost' },
    { RANDOM_REPLY_PROBABILITY: '' }, { RANDOM_REPLY_PROBABILITY: '-0.1' },
    { RANDOM_REPLY_PROBABILITY: '1.01' }, { RANDOM_REPLY_PROBABILITY: 'NaN' },
    { BATCH_SIZE: '0' }, { REPLY_MAX_CHARS: '1.2' }, { CODEX_SANDBOX: 'invalid' },
  ]) {
    assert.throws(() => loadConfig({ ...base, ...patch, NAPCAT_TOKEN: 'super-secret' }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /super-secret|secret\.example|user:secret/);
      return true;
    });
  }
});


test('新 Agent 配置优先于旧环境变量，旧输入仅作为读取回退', () => {
  const config = loadConfig({ ...base, CODEX_MODEL: 'old-model', CODEX_BASE_URL: 'https://old.example/v1',
    CODEX_API_KEY: 'old-key', CODEX_REASONING_EFFORT: 'medium', CODEX_CONTEXT_WINDOW: '128000',
    CODEX_AUTO_COMPACT_TOKEN_LIMIT: '100000', CODEX_TIMEOUT_MS: '123456', CODEX_HOME: '/old/codex',
    CODEX_WORKSPACE: '/old/workspace', CODEX_SANDBOX: 'danger-full-access' });
  assert.equal(config.agentModel, 'old-model'); assert.equal(config.agentBaseUrl, 'https://old.example/v1');
  assert.equal(config.agentApiKey, 'old-key'); assert.equal(config.agentReasoning, 'medium');
  assert.equal(config.agentContextWindow, 128000); assert.equal(config.agentCompactLimit, 100000);
  assert.equal(config.agentTimeoutMs, 123456); assert.ok(config.agentHome.endsWith('/data/pi'));
  assert.equal(config.workspace, '/old/workspace'); assert.equal(config.allowCommands, true); assert.equal(config.allowFileWrites, true);
  const override = loadConfig({ ...base, CODEX_MODEL: 'old-model', AGENT_MODEL: 'new-model', CODEX_SANDBOX: 'danger-full-access',
    AGENT_ALLOW_COMMANDS: 'false', AGENT_ALLOW_FILE_WRITES: 'false', AGENT_API: 'openai-completions', AGENT_SUPPORTS_IMAGES: 'false', AGENT_SUPPORTS_REASONING: 'false', AGENT_PERSONA: 'persona' });
  assert.equal(override.agentModel, 'new-model'); assert.equal(override.allowCommands, false); assert.equal(override.allowFileWrites, false);
  assert.equal(override.agentApi, 'openai-completions'); assert.equal(override.agentSupportsImages, false); assert.equal(override.agentSupportsReasoning, false);
  assert.equal(override.persona, 'persona');
});

test('工具权限的旧沙箱映射不会扩大能力', () => {
  for (const [sandbox, commands, writes] of [['read-only', false, false], ['workspace-write', false, true], ['danger-full-access', true, true]] as const) {
    const config = loadConfig({ ...base, CODEX_SANDBOX: sandbox });
    assert.equal(config.allowCommands, commands); assert.equal(config.allowFileWrites, writes);
  }
  for (const key of ['AGENT_ALLOW_COMMANDS', 'AGENT_ALLOW_FILE_WRITES', 'AGENT_SUPPORTS_IMAGES', 'AGENT_SUPPORTS_REASONING']) {
    assert.throws(() => loadConfig({ ...base, [key]: 'private-secret' }), error => error instanceof Error && error.message.includes(key) && !error.message.includes('private-secret'));
  }
  assert.throws(() => loadConfig({ ...base, AGENT_API: 'unsupported' }), /AGENT_API/u);
});
