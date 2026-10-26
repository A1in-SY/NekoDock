import { useEffect, useState } from "react";
import type {
  BotSettings,
  PublicBot,
  SecretField,
} from "../../src/console/contracts";
import { api, errorText } from "./api";
import { Icon, Notice } from "./ui";

type Settings = PublicBot["config"];
type Section =
  | "general"
  | "model"
  | "persona"
  | "search"
  | "voice"
  | "advanced";
const sections: [Section, string, string][] = [
  ["general", "bots", "基本设置"],
  ["model", "spark", "模型与上下文"],
  ["persona", "document", "人格设定"],
  ["search", "globe", "网络搜索"],
  ["voice", "mic", "语音回复"],
  ["advanced", "sliders", "高级设置"],
];
export function Configuration({
  bot,
  onSaved,
  notify,
}: {
  bot: PublicBot;
  onSaved: (bot: PublicBot) => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [section, setSection] = useState<Section>("general");
  const [draft, setDraft] = useState<Settings>({ ...bot.config });
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState(bot.description);
  const [secrets, setSecrets] = useState<
    Partial<Record<SecretField, string | null>>
  >({});
  const [revision, setRevision] = useState(bot.desiredRevision);
  const [saved, setSaved] = useState({
    name: bot.name,
    description: bot.description,
    config: bot.config,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const dirty =
    name !== saved.name ||
    description !== saved.description ||
    JSON.stringify(draft) !== JSON.stringify(saved.config) ||
    Object.keys(secrets).length > 0;
  const reset = () => {
    setDraft({ ...bot.config });
    setName(bot.name);
    setDescription(bot.description);
    setSecrets({});
    setRevision(bot.desiredRevision);
    setSaved({
      name: bot.name,
      description: bot.description,
      config: bot.config,
    });
    setError("");
  };
  useEffect(() => {
    if (!dirty) {
      setDraft({ ...bot.config });
      setName(bot.name);
      setDescription(bot.description);
      setRevision(bot.desiredRevision);
      setSaved({
        name: bot.name,
        description: bot.description,
        config: bot.config,
      });
    }
  }, [bot.desiredRevision]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const patch = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((old) => ({ ...old, [key]: value }));
    setError("");
  };
  const field = (
    label: string,
    key: keyof Settings,
    hint = "",
    type = "text",
    full = false,
    opts: {
      min?: number;
      max?: number;
      step?: number;
      readOnly?: boolean;
    } = {},
  ) => (
    <div className={"form-field " + (full ? "full" : "")} key={key}>
      <label htmlFor={"f-" + key}>{label}</label>
      <input
        id={"f-" + key}
        name={key}
        type={type}
        value={draft[key] === undefined ? "" : String(draft[key])}
        {...opts}
        onChange={(e) => {
          const value =
            type === "number" ? Number(e.target.value) : e.target.value;
          patch(key, value as never);
        }}
      />
      {hint && <small className="field-hint">{hint}</small>}
    </div>
  );
  const select = (
    label: string,
    key: keyof Settings,
    options: readonly (string | readonly [string, string])[],
    hint = "",
    full = false,
  ) => (
    <div className={"form-field " + (full ? "full" : "")} key={key}>
      <label htmlFor={"f-" + key}>{label}</label>
      <select
        id={"f-" + key}
        value={String(draft[key])}
        onChange={(e) => patch(key, e.target.value as never)}
      >
        {options.map((o) => {
          const [value, text] = typeof o === "string" ? [o, o] : o;
          return (
            <option value={value} key={value}>
              {text}
            </option>
          );
        })}
      </select>
      {hint && <small className="field-hint">{hint}</small>}
    </div>
  );
  const secret = (label: string, key: SecretField) => (
    <SecretInput
      key={key}
      label={label}
      field={key}
      configured={bot.configuredSecrets[key]}
      value={secrets[key]}
      onChange={(value) =>
        setSecrets((old) => {
          const next = { ...old };
          if (value === undefined) delete next[key];
          else next[key] = value;
          return next;
        })
      }
    />
  );
  const providers = (
    key: "searchProvider" | "ttsProvider",
    options: [string, string, string, string][],
  ) => (
    <div className="provider-options">
      {options.map(([value, title, description, icon]) => (
        <button
          type="button"
          key={value}
          className={
            "provider-option " + (draft[key] === value ? "active" : "")
          }
          onClick={() => patch(key, value as never)}
          aria-pressed={draft[key] === value}
        >
          <span className="provider-title">
            <Icon name={icon} />
            {title}
          </span>
          <small>{description}</small>
          <i className="provider-radio" />
        </button>
      ))}
    </div>
  );
  const toggle = (
    label: string,
    key: "supportsImages" | "supportsReasoning" | "allowCommands" | "allowFileWrites",
    hint: string,
  ) => (
    <div className="switch-row" key={key}>
      <div className="switch-copy"><strong>{label}</strong><p>{hint}</p></div>
      <label className="toggle">
        <input aria-label={label} type="checkbox" checked={draft[key]} onChange={(e) => patch(key, e.target.checked)} />
        <span className="toggle-track" />
      </label>
    </div>
  );
  const range = (
    label: string,
    key: "replyProbability" | "voiceProbability",
    hint: string,
  ) => (
    <div className="form-field full">
      <label htmlFor={"f-" + key}>{label}</label>
      <div className="range-wrap">
        <input
          type="range"
          id={"f-" + key}
          min={0}
          max={100}
          step={1}
          value={draft[key]}
          onChange={(e) => patch(key, Number(e.target.value))}
        />
        <output className="range-value" htmlFor={"f-" + key}>
          {draft[key]}%
        </output>
      </div>
      <small className="field-hint">{hint}</small>
    </div>
  );
  const save = async () => {
    setPending(true);
    setError("");
    try {
      const config: Record<string, unknown> = { ...draft, ...secrets };
      const updated = await api<PublicBot>(
        "/api/bots/" + encodeURIComponent(bot.id),
        {
          method: "PUT",
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim(),
            config,
            expectedRevision: revision,
          }),
        },
      );
      setDraft({ ...updated.config });
      setName(updated.name);
      setDescription(updated.description);
      setSecrets({});
      setRevision(updated.desiredRevision);
      setSaved({
        name: updated.name,
        description: updated.description,
        config: updated.config,
      });
      await onSaved(updated);
    } catch (error) {
      setError(errorText(error));
      notify(errorText(error), true);
    } finally {
      setPending(false);
    }
  };
  let body;
  switch (section) {
    case "general":
      body = (
        <>
          <h2>基本设置</h2>
          <p className="config-intro">
            设置实例名称和消息策略，查看绑定的固定会话。
          </p>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="f-name">实例名称</label>
              <input
                id="f-name"
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="f-description">备注</label>
              <input
                id="f-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="f-target-type">绑定会话类型</label>
              <input
                id="f-target-type"
                value={bot.targetType === "group" ? "QQ 群聊" : "QQ 私聊"}
                readOnly
                aria-readonly="true"
              />
              <small className="field-hint">
                创建后不可更改；绑定其他会话请新建实例。
              </small>
            </div>
            <div className="form-field">
              <label htmlFor="f-target-id">
                {bot.targetType === "group" ? "QQ 群号" : "对方 QQ 号"}
              </label>
              <input
                id="f-target-id"
                value={bot.targetId}
                readOnly
                aria-readonly="true"
              />
            </div>
            {bot.targetType === "group" &&
              range(
                "普通消息回复概率",
                "replyProbability",
                "被 @ 时正常回复；普通非表情包消息按此概率参与。",
              )}
          </div>
          <hr className="form-divider" />
          <h3 className="form-subtitle">NapCat 连接</h3>
          <div className="form-grid">
            {field(
              "WebSocket 地址",
              "wsUrl",
              "填写 NapCat WebSocket 服务端地址。",
              "text",
              true,
            )}
            {secret("访问 Token", "napcatToken")}
          </div>
          <Notice>
            {bot.targetType === "group"
              ? "处理消息期间，普通消息不会触发主动回复；被 @ 时先发送等待提示，再继续排队处理。"
              : "私聊消息正常回复；正在处理时，新消息会排队进入下一轮。"}
          </Notice>
        </>
      );
      break;
    case "model":
      body = (
        <>
          <h2>模型与上下文</h2>
          <p className="config-intro">
            选择模型服务，调整思考深度和会话的上下文容量。
          </p>
          <div className="form-grid">
            {select("API 协议", "modelApi", [
              ["openai-responses", "Responses"],
              ["openai-completions", "Chat Completions"],
            ], "按服务商实际支持选择；执行失败时不会自动切换协议。", true)}
            {field("API Base URL", "baseUrl", "填写服务地址，包含服务商要求的 /v1 等路径。", "url", true)}
            {secret("API Key", "modelApiKey")}
            {field(
              "模型 ID",
              "model",
              "例如 cmd/deepseek-v4.1-flash-fast",
              "text",
              true,
            )}
            {draft.supportsReasoning && select(
              "思考等级", "reasoning",
              ["", "none", "minimal", "low", "medium", "high", "xhigh", "max"].map(value => [value, value || "default"] as const),
              "仅发送所选等级；服务商与模型需实际支持。",
            )}
            {field("最大输出 · tokens", "maxOutputTokens", "包含模型的输出预算，须小于等于上下文预留量。", "number", false, { min: 1, step: 1 })}
          </div>
          <hr className="form-divider" />
          <h3 className="form-subtitle">模型能力</h3>
          {toggle("支持图片输入", "supportsImages", "关闭时不向模型发送图片内容。")}
          {toggle("支持思考参数", "supportsReasoning", "按模型能力开启；关闭后保留已选等级，但不发送思考参数。")}
          <hr className="form-divider" />
          <h3 className="form-subtitle">上下文管理</h3>
          <div className="form-grid">
            {field(
              "上下文窗口 · tokens",
              "contextWindow",
              "默认 200000；不能超过服务商和模型的实际能力。",
              "number",
              false,
              { min: 1, step: 1 },
            )}
            {field(
              "自动压缩阈值 · tokens",
              "compactLimit",
              "默认 160000；窗口与阈值之间须留足最大输出空间。",
              "number",
              false,
              { min: 1, step: 1 },
            )}
          </div>
          <Notice>
            每个实例维护独立会话。模型与人格配置在当前轮结束后应用；需要空会话时使用 /new。
          </Notice>
        </>
      );
      break;
    case "persona":
      body = (
        <>
          <h2>人格设定</h2>
          <p className="config-intro">
            写下它是谁、怎么说话，以及你希望它记住的相处方式。
          </p>
          <div className="persona-toolbar">
            <span>
              <Icon name="document" /> 自定义人格
            </span>
            <span className="code-tag">PLAIN TEXT</span>
          </div>
          <div className="form-field">
            <label className="hidden" htmlFor="f-persona">
              人格内容
            </label>
            <textarea
              id="f-persona"
              className="persona-editor"
              spellCheck={false}
              value={draft.persona}
              onChange={(e) => patch("persona", e.target.value)}
            />
            <small className="field-hint">
              人格作用于当前实例。无需指定文件名或挂载路径。
            </small>
          </div>
          <Notice>
            人格与基础运行指令一起构成会话的行为约束。保持自然聊天，优先回应眼前的话题。
          </Notice>
        </>
      );
      break;
    case "search":
      body = (
        <>
          <h2>网络搜索</h2>
          <p className="config-intro">
            需要查资料时，让它使用你选择的搜索服务。
          </p>
          {providers("searchProvider", [
            ["none", "关闭", "不启用网络搜索", "globe"],
            ["tavily", "Tavily", "为模型提供搜索与网页读取", "search"],
          ])}
          {draft.searchProvider === "tavily" ? (
            <div className="form-grid">
              {secret("Tavily API Key", "tavilyApiKey")}
              {field(
                "服务地址",
                "searchBaseUrl",
                "默认 https://api.tavily.com，也可填写自定义代理地址。",
                "url",
                true,
              )}
              {select("搜索深度", "searchDepth", [
                ["basic", "Basic · 标准"],
                ["advanced", "Advanced · 深入"],
              ])}
              {field(
                "最多返回来源数",
                "searchResults",
                "范围 1–20。",
                "number",
                false,
                { min: 1, max: 20 },
              )}
              {field(
                "请求超时 · 秒",
                "searchTimeout",
                "超时后返回问题，不持续重复尝试。",
                "number",
                false,
                { min: 1, max: 3600 },
              )}
            </div>
          ) : (
            <Notice>搜索已关闭。Bot 会根据已有知识和当前对话回答。</Notice>
          )}
        </>
      );
      break;
    case "voice":
      body = (
        <>
          <h2>语音回复</h2>
          <p className="config-intro">
            选择一个声音，让文字偶尔变成一句自然的语音。
          </p>
          <div
            className="switch-row"
            style={{ paddingTop: 0, marginBottom: 10 }}
          >
            <div className="switch-copy">
              <strong>开启语音回复</strong>
              <p>关闭时只发送文字；供应商设置会保留。</p>
            </div>
            <label className="toggle">
              <input
                aria-label="开启语音回复"
                type="checkbox"
                checked={draft.voiceEnabled}
                onChange={(e) => patch("voiceEnabled", e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
          </div>
          {draft.voiceEnabled && (
            <div className="form-grid" style={{ marginBottom: 23 }}>
              {range(
                "语音回复概率",
                "voiceProbability",
                "仅开启语音回复时生效；没有选中语音的回复仍发送文字。",
              )}
            </div>
          )}
          <span className="field-label">语音供应商</span>
          {providers("ttsProvider", [
            ["none", "不使用", "暂不选择语音服务", "mute"],
            ["edge-tts", "Edge TTS", "免费云端 · 无需 API Key", "mic"],
            ["mimo", "小米 MiMo", "预制音色 · 支持朗读风格", "spark"],
          ])}
          {draft.ttsProvider === "mimo" ? (
            <div className="form-grid">
              {secret("MiMo API Key", "mimoApiKey")}
              {field(
                "服务地址",
                "ttsBaseUrl",
                "默认 https://api.xiaomimimo.com/v1",
                "url",
                true,
              )}
              {select("音色", "ttsVoice", [
                "mimo_default",
                "冰糖",
                "茉莉",
                "苏打",
                "白桦",
                "Mia",
                "Chloe",
                "Milo",
                "Dean",
              ])}
              {field("语音模型", "ttsModel", "当前支持 mimo-v2.5-tts。")}
              <div className="form-field full">
                <label htmlFor="f-ttsStyle">朗读风格</label>
                <textarea
                  id="f-ttsStyle"
                  rows={4}
                  maxLength={4000}
                  value={draft.ttsStyle}
                  onChange={(e) => patch("ttsStyle", e.target.value)}
                  placeholder="描述语气、节奏和情绪…"
                />
                <small className="field-hint">
                  只影响朗读，不修改人格。留空则使用音色默认风格。
                </small>
              </div>
            </div>
          ) : draft.ttsProvider === "edge-tts" ? (
            <div className="form-grid">
              {field(
                "音色",
                "edgeVoice",
                "例如 zh-CN-XiaoxiaoNeural；支持 Edge TTS 音色名称。",
                "text",
                true,
              )}
              {field("语速", "edgeRate", "例如 +10% 或 -5%。")}
              {field("音调", "edgePitch", "例如 +5Hz。")}
              {field("音量", "edgeVolume", "例如 +0%。")}
            </div>
          ) : (
            <Notice>选中 Edge TTS 或小米 MiMo 后，即可配置声音。</Notice>
          )}
          {draft.ttsProvider !== "none" && (
            <>
              <div className="form-grid voice-limits">
                {field(
                  "语音合成超时 · 秒",
                  "ttsTimeout",
                  "超过此时间后回退文字。",
                  "number",
                  false,
                  { min: 1 },
                )}
                {field(
                  "语音文本上限 · 字",
                  "ttsMaxChars",
                  "更长的回复使用文字。",
                  "number",
                  false,
                  { min: 1 },
                )}
                {field(
                  "音频大小上限 · MiB",
                  "ttsMaxMiB",
                  "限制合成音频大小。",
                  "number",
                  false,
                  { min: 1 },
                )}
              </div>
              <Notice>
                {draft.voiceEnabled
                  ? "语音以 QQ 原生语音消息发送；合成失败时自动回退到文字。"
                  : "当前语音回复已关闭。这里的设置会保留，开启后才会生效。"}
              </Notice>
            </>
          )}
        </>
      );
      break;
    case "advanced":
      body = (
        <>
          <h2>高级设置</h2>
          <p className="config-intro">
            调整消息批次、超时与资源边界。大部分场景保留默认即可。
          </p>
          <h3 className="form-subtitle">工具权限</h3>
          {toggle("允许写入文件", "allowFileWrites", "允许模型通过文件工具修改当前实例的工作目录。")}
          {toggle("允许终端命令", "allowCommands", "允许以 node 用户权限运行容器内命令；命令可访问该用户有权限的文件。")}
          <hr className="form-divider" />
          <div className="form-grid">
            {field(
              "每批最多消息条数",
              "batchSize",
              "一轮交给模型的新增消息上限，不会等待攒够，也不是上下文长度。",
              "number",
              false,
              { min: 1, max: 1000 },
            )}
            {field(
              "文字回复每段最多字数",
              "replyMaxChars",
              "较长回复会拆分发送，范围 1–10000。",
              "number",
              false,
              { min: 1, max: 10000 },
            )}
            {field(
              "模型执行超时 · 秒",
              "modelTimeout",
              "一轮任务允许的最长执行时间。",
              "number",
              false,
              { min: 1 },
            )}
            {field(
              "发送动作超时 · 秒",
              "actionTimeout",
              "等待 NapCat 返回发送确认的时间。",
              "number",
              false,
              { min: 1 },
            )}
            {field(
              "控制队列退避间隔 · 秒",
              "retrySeconds",
              "指令确认或存储清理错误后的等待时间；不重试模型或普通回复。",
              "number",
              false,
              { min: 1 },
            )}
            {field(
              "断线重连间隔 · 秒",
              "reconnectSeconds",
              "NapCat 连接断开后的重连间隔。",
              "number",
              false,
              { min: 1 },
            )}
            {field(
              "图片大小上限 · MiB",
              "imageMaxMiB",
              "限制接收并交给模型的单张图片大小。",
              "number",
              false,
              { min: 1 },
            )}
            {field(
              "图片下载超时 · 秒",
              "imageTimeout",
              "读取消息图片的最长等待时间。",
              "number",
              false,
              { min: 1 },
            )}
          </div>
        </>
      );
      break;
  }
  return (
    <div className="config-layout">
      <aside className="panel config-nav">
        {sections.map(([id, icon, title]) => (
          <button
            key={id}
            className={section === id ? "active" : ""}
            onClick={() => setSection(id)}
          >
            <Icon name={icon} />
            {title}
          </button>
        ))}
        <div className="config-nav-hint">
          配置集中在这里管理，
          <br />
          无需编辑环境文件。
        </div>
      </aside>
      <div>
        <div
          className={
            "revision-state " +
            (bot.appliedRevision === bot.desiredRevision ? "applied" : "")
          }
        >
          <Icon
            name={
              bot.appliedRevision === bot.desiredRevision ? "check" : "clock"
            }
          />
          <span>
            {bot.appliedRevision === bot.desiredRevision
              ? `版本 ${bot.desiredRevision} 已生效`
              : `版本 ${bot.desiredRevision} 已保存，等待生效 · 当前版本 ${bot.appliedRevision}`}
          </span>
          {revision !== bot.desiredRevision && dirty && (
            <strong>配置已在其他位置更新，保存前请放弃更改后重新编辑。</strong>
          )}
        </div>
        <section className="panel config-panel">{body}</section>
        {error && (
          <div className="field-error config-error" role="alert">
            {error}
          </div>
        )}
        <div className="config-savebar">
          <div className={"save-state " + (dirty ? "dirty" : "")}>
            <Icon name={dirty ? "info" : "check"} />
            {pending
              ? "正在保存…"
              : dirty
                ? "有未保存的更改"
                : "所有更改已保存"}
          </div>
          <div>
            <button
              className="btn"
              disabled={!dirty || pending}
              onClick={reset}
            >
              放弃更改
            </button>
            <button
              className="btn primary"
              disabled={!dirty || pending || revision !== bot.desiredRevision}
              onClick={() => void save()}
            >
              <Icon name="check" />
              保存配置
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
function SecretInput({
  label,
  field,
  configured,
  value,
  onChange,
}: {
  label: string;
  field: SecretField;
  configured: boolean;
  value: string | null | undefined;
  onChange: (v: string | null | undefined) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="form-field full">
      <label htmlFor={"f-" + field}>{label}</label>
      <div className="secret-row">
        <div className="password-field">
          <input
            id={"f-" + field}
            type={visible ? "text" : "password"}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value || undefined)}
            disabled={value === null}
            autoComplete="new-password"
            placeholder={
              value === null
                ? "保存后清除此凭据"
                : configured
                  ? "已配置，留空保留"
                  : "输入凭据"
            }
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={"显示或隐藏" + label}
          >
            <Icon name="eye" />
          </button>
        </div>
        {configured && (
          <button
            type="button"
            className={"btn " + (value === null ? "" : "danger")}
            onClick={() => onChange(value === null ? undefined : null)}
          >
            {value === null ? "保留原凭据" : "清除"}
          </button>
        )}
      </div>
      <small className="field-hint">
        {value === null
          ? "已标记清除，保存配置后生效。"
          : "凭据加密保存，保存后不回显原值。"}
      </small>
    </div>
  );
}
