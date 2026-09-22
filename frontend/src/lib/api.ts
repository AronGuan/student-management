/**
 * API 客户端。契约唯一真源：docs/openapi.yaml
 * - 统一响应 { code, data, message }；code === 0 为成功
 * - 认证：浏览器走 httpOnly Cookie `ae_token`（credentials: 'include'），
 *   同时把 /auth/login 返回的 token 复写一份到 localStorage 供 Bearer 兜底
 */

export const API_BASE = import.meta.env.VITE_API_BASE ?? '/api/v1';

const TOKEN_KEY = 'ae_bearer_token';

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage 不可用时静默降级为纯 cookie 模式 */
  }
}

export interface ApiEnvelope<T> {
  code: number;
  data: T;
  message?: string;
}

/**
 * Envelope metadata for the paginated endpoints (/students, /follow-ups).
 *
 * The key is `has_more`, matching handler.Page's json tag (respond.go:50).
 * It was briefly spelled `hasMore` here, which meant every reader got
 * `undefined` and any "next page" control was permanently disabled - the
 * failure was silent because `undefined` is falsy, not an error.
 */
export interface PageMeta {
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
}

export class ApiError extends Error {
  readonly code: number;
  readonly status: number;

  constructor(code: number, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * 业务错误码 → 界面文案。**未列出的走服务端 message。**
 *
 * 注意：不要见到新码就往这里加。这里的文案会**覆盖**服务端 message，
 * 所以只登记「服务端文案对用户不够友好」的码；服务端已经说得更具体的码登记进来是**降级**：
 *
 *   40300  → 登记。服务端文案「当前角色无权执行该操作」对用户太干，且这是角色边界上的常见误操作。
 *
 *   40000  → **刻意不登记**。服务端 message 形如「weekday 必须是数字」，指明了是哪个参数。
 *            泛化成「请求参数有误。」会丢掉「是哪个参数」这个信息。
 *   40907  → **刻意不登记**。服务端文案「该学生未报名这节课所属的班级」已经说清了业务原因，泛化没好处。
 *   42202  → **刻意不登记**。R8 白名单失败是内部降级信号，正常路径下不呈现为错误
 *            （服务端返回 200 + ai_status），不该有面向用户的文案。
 *   50000  → **刻意不登记**。服务端文案「服务器内部错误，请稍后重试。」即是面向用户的兜底描述，
 *            客户端再覆写一层没有增量。
 */
const CODE_MESSAGES: Record<number, string> = {
  40100: '登录已过期，请重新登录。',
  40300: '当前角色没有该操作权限。',
  40301: '该学生属于其他顾问，仅可查看。',
  40400: '未找到该记录。',
  40901: '该周时间槽与已报班级重叠。',
  40902: '该时间槽老师已有课。',
  40903: '班级名额已满。',
  40904: '课时余额为 0，无法报名。',
  40905: '该学生已试听过这个科目。',
  40906: '这节课的出勤已结算。',
  42201: '出勤状态不合法，老师只能记录出勤 / 迟到 / 缺席。',
};

export function humaniseError(err: unknown): string {
  if (err instanceof ApiError) {
    return CODE_MESSAGES[err.code] ?? err.message ?? '请求失败。';
  }
  if (err instanceof Error) return err.message;
  return '请求失败。';
}

type Query = Record<string, string | number | boolean | undefined | null>;

function buildUrl(path: string, query?: Query): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function request<T>(
  method: string,
  path: string,
  options: { body?: unknown; query?: Query } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      credentials: 'include',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(-1, '无法连接服务器，请确认 API 正在运行。', 0); // 前端本地哨兵码，非服务端业务码
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: ApiEnvelope<T> | null = null;
  if (text) {
    try {
      payload = JSON.parse(text) as ApiEnvelope<T>;
    } catch {
      throw new ApiError(-1, '服务器返回了无法解析的响应。', response.status); // 前端本地哨兵码，非服务端业务码
    }
  }

  if (!response.ok || !payload || payload.code !== 0) {
    const code = payload?.code ?? response.status;
    const message = payload?.message ?? `请求失败（${response.status}）。`;
    throw new ApiError(code, message, response.status);
  }

  return payload.data;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  del: <T>(path: string) => request<T>('DELETE', path),
};
