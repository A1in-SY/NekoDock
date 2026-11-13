import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MODEL_SETTING_KEYS, modelSettings, type ModelSettings, type ModelPresetBinding, type ModelPresetSelection, type PublicModelPreset } from '../model-preset-contract.js';
import type { BotRecord } from './contracts.js';
import { defaultSettings, validateSettings } from './settings.js';

interface PresetRow { id: string; name: string; revision: number; config_cipher: string; created_at: number; updated_at: number }
interface Host {
  encrypt(value: unknown): string; decrypt(value: string): unknown;
  transaction<T>(fn: () => T): T; requireBot(id: string): BotRecord;
  change(id: string, type: string): void;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型预设内容必须为对象');
  return value as Record<string, unknown>;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new Error('模型预设名称必须为 1 至 80 字符');
  return value.trim();
}
function version(value: unknown, expected: number): void {
  if (!Number.isSafeInteger(value) || value !== expected) throw new Error('模型预设配置版本冲突，请刷新后重试');
}
export function presetSelection(value: unknown): ModelPresetSelection {
  const input = object(value);
  if (Object.keys(input).some(key => !['id', 'revision'].includes(key)) || typeof input.id !== 'string' || !input.id || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1)
    throw new Error('模型预设选择无效');
  return {id: input.id, revision: Number(input.revision)};
}

export class ModelPresets {
  constructor(private db: DatabaseSync, private host: Host) {
    db.exec(`CREATE TABLE IF NOT EXISTS model_presets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL, config_cipher TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_preset_bindings (
      bot_id TEXT NOT NULL, config_revision INTEGER NOT NULL, preset_id TEXT NOT NULL,
      preset_revision INTEGER NOT NULL, name TEXT NOT NULL, PRIMARY KEY(bot_id,config_revision),
      FOREIGN KEY(bot_id,config_revision) REFERENCES config_revisions(bot_id,revision)
    );`);
    const first = this.db.prepare('SELECT config_cipher FROM model_presets LIMIT 1').get() as {config_cipher: string} | undefined;
    if (first) host.decrypt(first.config_cipher);
  }
  private row(id: string): PresetRow {
    if (typeof id !== 'string') throw new Error('模型预设不存在');
    const row = this.db.prepare('SELECT * FROM model_presets WHERE id=?').get(id) as unknown as PresetRow | undefined;
    if (!row) throw new Error('模型预设不存在');
    return row;
  }
  private config(row: PresetRow): ModelSettings { return modelSettings(this.host.decrypt(row.config_cipher) as ModelSettings); }
  private public(row: PresetRow): PublicModelPreset {
    const {modelApiKey, ...config} = this.config(row);
    return {id: row.id, name: row.name, revision: row.revision, config, keyConfigured: !!modelApiKey,
      createdAt: row.created_at, updatedAt: row.updated_at};
  }
  list(): PublicModelPreset[] {
    return (this.db.prepare('SELECT * FROM model_presets ORDER BY created_at,id').all() as unknown as PresetRow[]).map(row => this.public(row));
  }
  private validate(input: unknown, existing?: ModelSettings): ModelSettings {
    const patch = object(input);
    if (Object.keys(patch).some(key => !(MODEL_SETTING_KEYS as readonly string[]).includes(key))) throw new Error('模型预设包含未知配置项');
    const config = modelSettings(validateSettings(patch, {...defaultSettings(), ...existing}));
    if (!config.model || !config.baseUrl) throw new Error('模型预设必须填写模型 ID 和 Base URL');
    return config;
  }
  create(input: unknown): PublicModelPreset {
    const body = object(input);
    if (Object.keys(body).some(key => !['name', 'config'].includes(key))) throw new Error('模型预设包含未知配置项');
    return this.host.transaction(() => this.insert(name(body.name), this.validate(body.config)));
  }
  private insert(title: string, config: ModelSettings): PublicModelPreset {
    const id = randomUUID(), now = Date.now();
    this.db.prepare('INSERT INTO model_presets VALUES(?,?,1,?,?,?)').run(id, title, this.host.encrypt(config), now, now);
    this.host.change('', 'model-preset.created');
    return this.public(this.row(id));
  }
  fromBot(id: string, input: unknown): PublicModelPreset {
    const body = object(input);
    if (Object.keys(body).some(key => !['name', 'expectedRevision'].includes(key))) throw new Error('模型预设包含未知配置项');
    return this.host.transaction(() => {
      const bot = this.host.requireBot(id); version(body.expectedRevision, bot.desiredRevision);
      return this.insert(name(body.name), this.validate(modelSettings(bot.config)));
    });
  }
  update(id: string, input: unknown): PublicModelPreset {
    const body = object(input);
    if (Object.keys(body).some(key => !['name', 'config', 'expectedRevision'].includes(key))) throw new Error('模型预设包含未知配置项');
    return this.host.transaction(() => {
      const row = this.row(id); version(body.expectedRevision, row.revision);
      const config = this.validate(body.config ?? {}, this.config(row));
      this.db.prepare('UPDATE model_presets SET name=?,revision=revision+1,config_cipher=?,updated_at=? WHERE id=?')
        .run(name(body.name ?? row.name), this.host.encrypt(config), Date.now(), id);
      this.host.change('', 'model-preset.updated');
      return this.public(this.row(id));
    });
  }
  delete(id: string, expectedRevision: unknown): void {
    this.host.transaction(() => {
      version(expectedRevision, this.row(id).revision);
      this.db.prepare('DELETE FROM model_presets WHERE id=?').run(id);
      this.host.change('', 'model-preset.deleted');
    });
  }
  resolve(input: unknown): {binding: ModelPresetBinding; config: Omit<ModelSettings, 'modelApiKey'> & {modelApiKey: string | null}} {
    const selection = presetSelection(input), row = this.row(selection.id);
    version(selection.revision, row.revision);
    const config = this.config(row);
    // A keyless preset must clear the previous provider's key as part of the same update.
    return {binding: {id: row.id, revision: row.revision, name: row.name}, config: {...config, modelApiKey: config.modelApiKey ?? null}};
  }
  binding(botId: string, revision: number): ModelPresetBinding | undefined {
    const row = this.db.prepare('SELECT preset_id,preset_revision,name FROM model_preset_bindings WHERE bot_id=? AND config_revision=?').get(botId, revision) as {preset_id: string; preset_revision: number; name: string} | undefined;
    return row ? {id: row.preset_id, revision: row.preset_revision, name: row.name} : undefined;
  }
  bind(botId: string, revision: number, binding?: ModelPresetBinding): void {
    if (binding) this.db.prepare('INSERT INTO model_preset_bindings VALUES(?,?,?,?,?)').run(botId, revision, binding.id, binding.revision, binding.name);
  }
}
