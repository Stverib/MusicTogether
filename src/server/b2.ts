/**
 * Backblaze B2 的原生 API 客户端。
 *
 * 为什么不用 S3 兼容接口：S3 的 SigV4 要求先把整个请求体算出 SHA-256，
 * 而 100 MB 的歌在 Worker 里根本不能缓冲（内存只有 128 MB）。B2 的原生
 * 上传接口允许 `X-Bz-Content-Sha1: do_not_verify`，配上已知长度的流就能
 * 边收边传，代价只是 B2 不做去重。
 *
 * 这里只用 Worker 的 fetch 与 FixedLengthStream，没有任何 Node API。
 */

export interface B2Config {
  keyId: string;
  applicationKey: string;
  bucketId: string;
  bucketName: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const API_ROOT = 'https://api.backblazeb2.com';
const API = `${API_ROOT}/b2api/v4`;
/** 令牌最长 24 小时，提前一小时换，避免卡在边界上 */
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

type Auth = { apiUrl: string; downloadUrl: string; token: string; expiresAt: number };
type Upload = { url: string; token: string; expiresAt: number };

/** B2 要求文件名做百分号编码，但路径分隔符 `/` 保持原样 */
export function encodeB2Path(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { code?: string };
    return body.code ?? '';
  } catch {
    return '';
  }
}

export class B2Client {
  private auth: Auth | null = null;
  private upload: Upload | null = null;
  private authInFlight: Promise<Auth> | null = null;

  constructor(
    private readonly config: B2Config,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async putObject(
    key: string,
    body: ReadableStream<Uint8Array>,
    length: number,
    contentType: string,
    filename: string,
  ): Promise<number> {
    if (!Number.isInteger(length) || length <= 0) throw new Error('bad length');

    const upload = await this.uploadUrl();
    // 与 R2 那条路一样：长度必须是硬约束，多了少了都让流报错，
    // 否则房间配额的账就对不上
    const fixed = new FixedLengthStream(length);
    const pumping = body.pipeTo(fixed.writable).catch(() => {});

    const res = await this.fetchImpl(upload.url, {
      method: 'POST',
      headers: {
        Authorization: upload.token,
        'X-Bz-File-Name': encodeB2Path(key),
        // 流式上传算不出 SHA1；B2 明确允许这个字面值
        'X-Bz-Content-Sha1': 'do_not_verify',
        'X-Bz-Info-name': encodeURIComponent(filename.slice(0, 200)),
        'Content-Type': contentType,
        'Content-Length': String(length),
      },
      body: fixed.readable,
    });

    if (!res.ok) {
      // 被拒时 B2 可能根本没读请求体，这时等 pumping 会永远等下去；
      // 请求体是一次性流，也没法重放，所以直接如实失败
      this.upload = null;
      const code = await errorCode(res);
      throw new Error(`b2 upload failed: ${res.status}${code ? ` ${code}` : ''}`);
    }

    await pumping;

    const info = (await res.json()) as { contentLength?: number };
    return info.contentLength ?? length;
  }

  async getObject(key: string, range: string | null): Promise<Response> {
    let auth = await this.ensureAuth();
    let res = await this.download(auth, key, range);

    if (res.status === 401) {
      // 读请求没有请求体，重试是安全的
      this.auth = null;
      this.upload = null;
      auth = await this.ensureAuth();
      res = await this.download(auth, key, range);
    }
    return res;
  }

  async deleteObject(key: string): Promise<void> {
    const auth = await this.ensureAuth();
    const query = new URLSearchParams({
      bucketId: this.config.bucketId,
      prefix: key,
      maxFileCount: '100',
    });
    const list = await this.fetchImpl(`${auth.apiUrl}/b2api/v4/b2_list_file_versions?${query}`, {
      headers: { Authorization: auth.token },
    });
    if (!list.ok) {
      throw new Error(`b2 list failed: ${list.status} ${await errorCode(list)}`);
    }
    const { files = [] } = (await list.json()) as {
      files?: { fileId?: string; fileName?: string }[];
    };

    for (const file of files) {
      // prefix 会顺带命中名字更长的对象，这里只要精确的那一个
      if (!file.fileId || file.fileName !== key) continue;
      const res = await this.fetchImpl(`${auth.apiUrl}/b2api/v4/b2_delete_file_version`, {
        method: 'POST',
        headers: {
          Authorization: auth.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fileId: file.fileId, fileName: file.fileName }),
      });
      if (!res.ok) {
        throw new Error(`b2 delete failed: ${res.status} ${await errorCode(res)}`);
      }
    }
  }

  private download(auth: Auth, key: string, range: string | null): Promise<Response> {
    const headers: Record<string, string> = { Authorization: auth.token };
    if (range) headers['Range'] = range;
    const url = `${auth.downloadUrl}/file/${encodeURIComponent(this.config.bucketName)}/${encodeB2Path(key)}`;
    return this.fetchImpl(url, { headers });
  }

  private async ensureAuth(): Promise<Auth> {
    if (this.auth && this.auth.expiresAt > Date.now()) return this.auth;
    // 并发上传时只换一次令牌
    if (!this.authInFlight) {
      this.authInFlight = this.authorize().finally(() => {
        this.authInFlight = null;
      });
    }
    return this.authInFlight;
  }

  private async authorize(): Promise<Auth> {
    const basic = btoa(`${this.config.keyId}:${this.config.applicationKey}`);
    const res = await this.fetchImpl(`${API}/b2_authorize_account`, {
      headers: { Authorization: `Basic ${basic}` },
    });
    if (!res.ok) {
      throw new Error(`b2 authorize failed: ${res.status} ${await errorCode(res)}`);
    }
    const data = (await res.json()) as {
      apiUrl: string;
      downloadUrl: string;
      authorizationToken: string;
    };
    this.auth = {
      apiUrl: data.apiUrl,
      downloadUrl: data.downloadUrl,
      token: data.authorizationToken,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    return this.auth;
  }

  private async uploadUrl(): Promise<Upload> {
    if (this.upload && this.upload.expiresAt > Date.now()) return this.upload;

    const auth = await this.ensureAuth();
    const query = new URLSearchParams({ bucketId: this.config.bucketId });
    const res = await this.fetchImpl(`${auth.apiUrl}/b2api/v4/b2_get_upload_url?${query}`, {
      headers: { Authorization: auth.token },
    });
    if (!res.ok) {
      throw new Error(`b2 get_upload_url failed: ${res.status} ${await errorCode(res)}`);
    }
    const data = (await res.json()) as { uploadUrl: string; authorizationToken: string };
    this.upload = {
      url: data.uploadUrl,
      token: data.authorizationToken,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    return this.upload;
  }
}
