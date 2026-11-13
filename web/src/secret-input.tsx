import { useState } from "react";
import type { SecretField } from "../../src/console/contracts";
import { Icon } from "./ui";

export function SecretInput({
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
