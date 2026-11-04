import assert from "node:assert/strict";
import test from "node:test";
import { canRunNetworkProbe, describeNetworkProbe } from "../src/network-probe-state.ts";
import type { NetworkProbe } from "../src/network-probe-state.ts";

test("network detection requires a running Worker with an applied configuration", () => {
  assert.equal(canRunNetworkProbe({state: "running", desiredState: "running", appliedRevision: 2}), true);
  assert.equal(canRunNetworkProbe({state: "running", desiredState: "stopped", appliedRevision: 2}), false);
  assert.equal(canRunNetworkProbe({state: "stopped", desiredState: "running", appliedRevision: 2}), false);
  assert.equal(canRunNetworkProbe({state: "running", desiredState: "running", appliedRevision: 0}), false);
});

test("network results identify the probed revision and HTTP reachability without claiming authentication", () => {
  const probe: NetworkProbe = {id: "test", status: "completed", revision: 2, result: {ok: true, code: "HTTP_REACHABLE", durationMs: 31.4, status: 401, route: "proxy"}};
  const text = describeNetworkProbe(probe, 3);
  assert.match(text, /配置版本 2/u); assert.match(text, /经代理/u); assert.match(text, /HTTP 401/u);
  assert.match(text, /31 ms/u); assert.match(text, /当前生效版本已变更/u);
  assert.doesNotMatch(text, /鉴权成功|模型正常/u);
});

test("network failures show fixed descriptions rather than arbitrary backend error prose", () => {
  const probe: NetworkProbe = {id: "test", status: "failed", revision: 2, result: {ok: false, code: "PROXY_AUTH_REQUIRED", durationMs: 30}};
  assert.match(describeNetworkProbe(probe, 2), /代理认证失败/u);
  assert.match(describeNetworkProbe({...probe, result: {...probe.result!, code: "unexpected-with-private-text"}}, 2), /检测失败，请查看实例日志/u);
  assert.doesNotMatch(describeNetworkProbe({...probe, result: {...probe.result!, code: "unexpected-with-private-text"}}, 2), /unexpected/u);
  assert.match(describeNetworkProbe({...probe, status: "pending"}, 2), /正在检测/u);
});
