export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  if (init.method && init.method !== "GET")
    headers.set("X-Console-Request", "1");
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  const result = await response
    .json()
    .catch(() => ({ error: "服务返回了无法读取的响应" }));
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/login")
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(
      result.error || `请求失败 (${response.status})`,
      response.status,
    );
  }
  return result as T;
}
export function post<T>(path: string, body: unknown = {}) {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : "请求未完成，请重试。";
}
