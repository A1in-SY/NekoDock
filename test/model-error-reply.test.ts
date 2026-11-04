import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelErrorReply } from '../src/model-error-reply.js';

test('model error reply exposes recognized provider reasons and trustworthy HTTP statuses', async t => {
  const cases: Array<[string, string]> = [
    ['PI_TIMEOUT', '模型调用失败：模型调用超时。'],
    ['PI_EXECUTION_FAILED: Connection error.', '模型调用失败：无法连接模型服务。'],
    ['PI_EXECUTION_FAILED: Response incomplete: content_filter', '模型调用失败：生成被模型服务拦截（content_filter）。'],
    ['PI_EXECUTION_FAILED: bridge API error (404): {"error":{"code":"model_not_found","message":"private model identifier"}}', '模型调用失败：模型不存在或当前账号无权使用（HTTP 404，model_not_found）。'],
    ['PI_EXECUTION_FAILED: 401 invalid authentication', '模型调用失败：模型服务鉴权失败（HTTP 401）。'],
    ['PI_EXECUTION_FAILED: HTTP 403: forbidden', '模型调用失败：当前账号没有调用权限（HTTP 403）。'],
    ['PI_EXECUTION_FAILED: bridge API error (429): {"error":{"code":"insufficient_quota"}}', '模型调用失败：模型服务额度不足（HTTP 429，insufficient_quota）。'],
    ['PI_EXECUTION_FAILED: 429 request rejected', '模型调用失败：模型服务请求受限或额度不足（HTTP 429）。'],
    ['PI_EXECUTION_FAILED: bridge API error (524): 524 {"error_name":"origin_response_timeout"}', '模型调用失败：模型服务响应超时（HTTP 524，origin_response_timeout）。'],
    ['PI_EXECUTION_FAILED: 400 maximum context length exceeded', '模型调用失败：输入超过模型上下文限制（HTTP 400）。'],
    ['PI_EXECUTION_FAILED: bridge API error (400): {"error":{"message":"maximum context length exceeded","type":"invalid_request_error"}}', '模型调用失败：输入超过模型上下文限制（HTTP 400）。'],
    ['PI_EXECUTION_FAILED: bridge API error (503): {"error":{"message":"Connection error.","type":"server_error"}}', '模型调用失败：无法连接模型服务（HTTP 503）。'],
    ['PI_EXECUTION_FAILED: 503 Media conversion failed: private diagnostic', '模型调用失败：模型服务处理媒体内容失败（HTTP 503）。'],
    ['PI_EXECUTION_FAILED: bridge API error (503): {"error":{"message":"Media conversion failed: Unknown error"}}', '模型调用失败：模型服务处理媒体内容失败（HTTP 503）。'],
    ['PI_EXECUTION_FAILED: bridge API error (503): {"message":"data:{\\"error\\":{\\"message\\":\\"Media conversion failed: Unknown error\\"}}"}', '模型调用失败：模型服务处理媒体内容失败（HTTP 503）。'],
    ['PI_EXECUTION_FAILED: bridge API error (503): {"message":"data:{\\"error\\":{\\"code\\":\\"ModelArts.81104\\",\\"message\\":\\"Media conversion failed: Unknown error\\"}}"}', '模型调用失败：模型服务处理媒体内容失败（HTTP 503，ModelArts.81104）。'],
    ['PI_EXECUTION_FAILED: HTTP 500: unknown error', '模型调用失败：模型服务暂时不可用（HTTP 500）。'],
    ['PI_EXECUTION_FAILED: unknown error', '模型调用失败：暂时无法确定具体原因。'],
  ];
  for (const [message, expected] of cases) await t.test(expected, () => assert.equal(modelErrorReply(new Error(message)), expected));
});

test('model error reply accepts validated structured status and ignores arbitrary body numbers', () => {
  assert.equal(modelErrorReply(Object.assign(new Error('unstructured provider error'), { providerStatus: 503 })), '模型调用失败：模型服务暂时不可用（HTTP 503）。');
  for (const message of ['PI_EXECUTION_FAILED: user body contains status 503', 'PI_EXECUTION_FAILED: {"message":"original input has HTTP 401 and 404"}', 'PI_EXECUTION_FAILED: 50300 private record'])
    assert.equal(modelErrorReply(new Error(message)), '模型调用失败：暂时无法确定具体原因。');
  for (const providerStatus of ['503', 200, 600, 503.5, NaN])
    assert.equal(modelErrorReply({ message: 'unknown', providerStatus }), '模型调用失败：暂时无法确定具体原因。');
  assert.equal(modelErrorReply(new Error('PI_EXECUTION_FAILED: bridge API error (400): {"error":{"message":"original user text mentions maximum context length exceeded"}}')), '模型调用失败：模型服务拒绝了请求（HTTP 400）。');
});

test('model error reply never echoes provider prose, private credentials, URLs, stack or unknown codes', () => {
  const secret = 'fake-provider-private-key';
  const error = new Error(`PI_EXECUTION_FAILED: bridge API error (503): ${JSON.stringify({ error: { code: secret, message: `input-private-body Bearer ${secret} https://private.example/v1?token=hidden host.docker.internal:8787` } })}`);
  error.stack = 'private-stack-fixture';
  assert.equal(modelErrorReply(error), '模型调用失败：模型服务暂时不可用（HTTP 503）。');
  assert.doesNotMatch(modelErrorReply(error), /private|Bearer|https|hidden|host\.docker/);
  assert.equal(modelErrorReply({ code: 'invalid_api_key', message: secret }), '模型调用失败：模型服务鉴权失败（invalid_api_key）。');
  for (const error of [null, undefined, 503, 'HTTP 503: private', {}, { message: 'private'.repeat(100_000) }])
    assert.equal(modelErrorReply(error), '模型调用失败：暂时无法确定具体原因。');
});
