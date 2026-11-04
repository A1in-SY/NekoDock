const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const scalar = (value: unknown) => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

/** Only actual message text can be a command; embedded cards are never commands. */
export function pluginCommandText(event: unknown): { sourceMessageId: string; text: string } | undefined {
  const value = object(event);
  const sourceMessageId = scalar(value?.message_id);
  if (!value || !sourceMessageId) return;
  let text = '';
  if (Array.isArray(value.message)) {
    for (const item of value.message) {
      const segment = object(item), data = object(segment?.data);
      if (!segment || !data) return;
      if (segment.type === 'text') text += scalar(data.text);
      else if (segment.type === 'reply') continue;
      else if (segment.type === 'at' && scalar(data.qq) === scalar(value.self_id)) continue;
      else return;
    }
  } else if (typeof value.message === 'string') {
    text = value.message.replace(/\[CQ:reply,[^\]]*\]/gu, '').replace(/\[CQ:at,qq=(\d+)\]/gu, (all, qq: string) => qq === scalar(value.self_id) ? '' : all);
    if (/\[CQ:/u.test(text)) return;
  } else return;
  return { sourceMessageId, text: text.trim() };
}
