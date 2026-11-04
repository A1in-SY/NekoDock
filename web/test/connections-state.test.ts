import assert from "node:assert/strict";
import test from "node:test";
import { affectedBots, botConnectionStates, canSelectConnection, canSwitchConnection, connectionLabel, connectionPayload, instanceSettings } from "../src/connections-state.ts";
import type { PublicBot } from "../../src/console/contracts.ts";
import type { ConnectionDraft, ConnectionView } from "../src/connections-state.ts";

const draft: ConnectionDraft = { name: "  Main connection ", wsUrl: " ws://napcat:3002/ ", reconnectSeconds: 3, actionTimeout: 15, enabled: true };

test("connection updates retain an existing secret unless replacement or clear is explicit", () => {
  const unchanged = connectionPayload(draft, 3);
  assert.equal("token" in unchanged, false);
  assert.equal(unchanged.expectedRevision, 3);
  assert.equal(unchanged.name, "Main connection");
  assert.equal(unchanged.wsUrl, "ws://napcat:3002/");
  assert.equal(connectionPayload({ ...draft, token: "synthetic-token" }).token, "synthetic-token");
  assert.equal(connectionPayload({ ...draft, token: null }).token, null);
  assert.equal("expectedRevision" in connectionPayload(draft), false);
});

test("connection payload rejects credentials in URLs and invalid intervals", () => {
  for (const wsUrl of ["https://napcat:3002", "ws://user:pass@napcat:3002", "ws://napcat:3002?token=placeholder", "invalid"])
    assert.throws(() => connectionPayload({ ...draft, wsUrl }));
  assert.throws(() => connectionPayload({ ...draft, reconnectSeconds: 0 }));
  assert.throws(() => connectionPayload({ ...draft, actionTimeout: Number.NaN }));
});

test("instance requests keep model settings while excluding shared connection credentials", () => {
  assert.deepEqual(instanceSettings({ wsUrl: "ws://napcat", napcatToken: "synthetic-token", actionTimeout: 15, reconnectSeconds: 3, model: "example-model", modelApiKey: "synthetic-model-key" }), { model: "example-model", modelApiKey: "synthetic-model-key" });
});

test("connection status distinguishes disabled, unknown, upstream and QQ login states", () => {
  const connection = { enabled: true } as ConnectionView;
  assert.equal(connectionLabel(connection), "等待状态");
  assert.equal(connectionLabel({ ...connection, connected: false }), "未连接");
  assert.equal(connectionLabel({ ...connection, connected: true, online: false }), "QQ 未在线");
  assert.equal(connectionLabel({ ...connection, connected: true, online: true }), "QQ 在线");
  assert.equal(connectionLabel({ ...connection, enabled: false, connected: true, online: true }), "已停用");
});

test("instance channels show independent failures and support older runtime snapshots", () => {
  assert.deepEqual(botConnectionStates({ connected: false, transportConnected: true, upstreamConnected: false, qqOnline: true }), { connected: false, transport: true, upstream: false, online: true });
  assert.deepEqual(botConnectionStates({ connected: true }), { connected: true, transport: true, upstream: true, online: true });
});

test("impact list only includes bots bound to the connection", () => {
  const bots = [{ id: "bot-a", name: "A" }, { id: "bot-b", name: "B" }] as PublicBot[];
  assert.deepEqual(affectedBots({ botIds: ["bot-b"] }, bots), [bots[1]]);
});

test("existing instances may switch only after stopping and only between verified connections of the same account", () => {
  const bot = { connectionId: "current", state: "stopped", desiredState: "stopped", processing: false } as const;
  const current = { id: "current", accountId: "123", enabled: true } as ConnectionView;
  const sameAccount = { id: "same", accountId: "123", enabled: true } as ConnectionView;
  const otherAccount = { id: "other", accountId: "456", enabled: true } as ConnectionView;
  const unverified = { id: "unknown", accountId: null, enabled: true } as ConnectionView;
  const connections = [current, sameAccount, otherAccount, unverified];
  assert.equal(canSwitchConnection(bot), true);
  assert.equal(canSelectConnection(bot, sameAccount, connections), true);
  assert.equal(canSelectConnection(bot, otherAccount, connections), false);
  assert.equal(canSelectConnection(bot, unverified, connections), false);
  assert.equal(canSelectConnection(bot, { ...sameAccount, enabled: false }, connections), false);
  assert.equal(canSelectConnection(bot, sameAccount, [sameAccount, { ...current, accountId: null }]), false);
  for (const changes of [{ state: "running" }, { state: "stopping" }, { desiredState: "running" }, { processing: true }] as const) {
    const active = { ...bot, ...changes };
    assert.equal(canSwitchConnection(active), false);
    assert.equal(canSelectConnection(active, sameAccount, connections), false);
    assert.equal(canSelectConnection(active, current, connections), true);
  }
  assert.equal(canSelectConnection(bot, { ...current, enabled: false, accountId: null }, connections), true);
});
