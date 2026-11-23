import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const metaBase = 'https://graph.threads.com';
const xBase = 'https://api.x.com/2';
const redirect = new URL('http://127.0.0.1:53682/callback');
const scopes = 'tweet.read tweet.write users.read media.write offline.access';
const postFields = 'id,text,timestamp,permalink,media_type,media_url,children,is_quote_post,reposted_post,link_attachment_url,gif_url,poll_attachment,text_attachment';
const replyFields = 'id,text,timestamp,permalink,username,is_reply_owned_by_me,hide_status';
const day = 86_400_000;

export class ApiError extends Error {
  constructor(label, response, body, credentials = false) {
    const inner = body?.error || body?.errors?.[0] || body;
    const detail = credentials ? '' : inner?.detail || inner?.message || inner?.title || '';
    super(`${label} HTTP ${response.status}${detail ? ` — ${String(detail).replace(/https?:\/\/\S+/gi, '[URL]').slice(0, 250)}` : ''}`);
    this.status = response.status;
    this.code = inner?.code;
    const retryAfter = response.headers.get('retry-after');
    const reset = response.headers.get('x-rate-limit-reset');
    this.retryAt = Math.max(
      retryAfter && /^\d+$/.test(retryAfter) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter) || 0,
      reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : 0,
    );
  }
}

async function jsonRequest(label, url, options = {}, credentials = false) {
  let response;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(45_000) });
  } catch {
    throw new Error(`${label} 연결 실패 또는 시간 초과`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(label, response, body, credentials);
  return body;
}

function endpoint(base, path, query = {}) {
  const url = new URL(`${base}/${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

function id(value, label) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`${label} 응답에 유효한 ID가 없습니다.`);
  return value;
}

export class Threads {
  constructor(store, env) {
    this.store = store;
    this.initial = env.THREADS_ACCESS_TOKEN;
    this.secret = env.THREADS_APP_SECRET;
  }

  async token() {
    if (!this.initial) throw new Error('.env에 THREADS_ACCESS_TOKEN을 입력하세요.');
    const fingerprint = createHash('sha256').update(this.initial).digest('hex');
    const saved = this.store.get('threadsToken');
    if (saved?.fingerprint !== fingerprint) {
      let token = this.initial;
      let refreshAt = Date.now();
      if (this.secret) {
        const url = endpoint(metaBase, 'access_token', {
          grant_type: 'th_exchange_token', client_secret: this.secret, access_token: token,
        });
        const result = await jsonRequest('Threads 장기 토큰 교환', url, {}, true);
        if (!result?.access_token) throw new Error('Threads 장기 토큰 응답이 비어 있습니다.');
        token = result.access_token;
        refreshAt = Date.now() + Math.min(30, result.expires_in / 86_400 / 2 || 30) * day;
      }
      this.store.set('threadsToken', { fingerprint, token, refreshAt });
      return token;
    }
    if (Date.now() < saved.refreshAt) return saved.token;
    const url = endpoint(metaBase, 'refresh_access_token', {
      grant_type: 'th_refresh_token', access_token: saved.token,
    });
    try {
      const result = await jsonRequest('Threads 토큰 갱신', url, {}, true);
      if (!result?.access_token) throw new Error('Threads 갱신 토큰 응답이 비어 있습니다.');
      this.store.set('threadsToken', {
        fingerprint, token: result.access_token, refreshAt: Date.now() + Math.min(30, result.expires_in / 86_400 / 2 || 30) * day,
      });
      return result.access_token;
    } catch (error) {
      console.warn(`${error.message}. 현재 토큰으로 조회하고 갱신을 다시 시도합니다.`);
      this.store.set('threadsToken', { ...saved, refreshAt: Date.now() + 6 * 3_600_000 });
      return saved.token;
    }
  }

  get(path, query = {}) {
    return jsonRequest('Threads', endpoint(`${metaBase}/v1.0`, path, { ...query, access_token: this.accessToken }));
  }

  async profile() {
    this.accessToken = await this.token();
    const user = await this.get('me', { fields: 'id,username' });
    id(user?.id, 'Threads 사용자');
    return user;
  }

  async list(path, query, all) {
    const items = [];
    const visited = new Set();
    let page = await this.get(path, query);
    for (;;) {
      if (!Array.isArray(page?.data)) throw new Error('Threads 목록 응답이 비어 있습니다.');
      items.push(...page.data);
      if (!all || !page.paging?.next) return items;
      const after = page.paging?.cursors?.after || new URL(page.paging.next).searchParams.get('after');
      if (!after || visited.has(after)) throw new Error('Threads 페이지 커서가 올바르지 않습니다.');
      visited.add(after);
      page = await this.get(path, { ...query, after });
    }
  }

  posts(since, until, limit = 50) {
    const time = since === undefined ? {} : { since: Math.floor(since / 1000), until: Math.floor(until / 1000) };
    return this.list('me/threads', { fields: postFields, limit, ...time }, since !== undefined);
  }

  post(postId) {
    return this.get(id(postId, 'Threads 게시물'), { fields: postFields });
  }

  asset(postId) {
    return this.get(id(postId, 'Threads 첨부 파일'), { fields: 'id,media_type,media_url,gif_url' });
  }

  replies(postId) {
    return this.list(`${id(postId, 'Threads 게시물')}/conversation`, { fields: replyFields, limit: 50, reverse: 'false' }, true);
  }

  async children(post) {
    if (!['CAROUSEL', 'CAROUSEL_ALBUM'].includes(post.media_type)) return [];
    if (post.children?.data?.length && !post.children.paging?.next) {
      const children = [];
      for (const child of post.children.data) children.push(await this.asset(child.id));
      return children;
    }
    return this.list(`${id(post.id, 'Threads 게시물')}/children`, { fields: 'id,media_type,media_url,gif_url', limit: 50 }, true);
  }
}

export class XApi {
  constructor(store, env) {
    this.store = store;
    this.clientId = env.X_CLIENT_ID;
    this.secret = env.X_CLIENT_SECRET;
  }

  async exchange(values, previous = {}) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (this.secret) headers.Authorization = `Basic ${Buffer.from(`${this.clientId}:${this.secret}`).toString('base64')}`;
    else values.client_id = this.clientId;
    const result = await jsonRequest('X OAuth', `${xBase}/oauth2/token`, {
      method: 'POST', headers, body: new URLSearchParams(values),
    }, true);
    const refreshToken = result?.refresh_token || previous.refreshToken;
    if (!result?.access_token || !refreshToken) throw new Error('X 로그인에 offline.access 권한이 필요합니다.');
    return {
      clientId: this.clientId, accessToken: result.access_token, refreshToken,
      expiresAt: Date.now() + (result.expires_in || 7200) * 1000,
    };
  }

  async login({ onAuthorize = url => console.log(`브라우저에서 아래 주소를 열고 게시할 X 계정으로 승인하세요.\n${url}`), verifyAccount, signal } = {}) {
    if (!this.clientId) throw new Error('.env에 X_CLIENT_ID를 입력하세요.');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const auth = endpoint('https://x.com/i', 'oauth2/authorize', {
      response_type: 'code', client_id: this.clientId, redirect_uri: redirect.href,
      scope: scopes, state, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });

    const code = await new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        const url = new URL(request.url, redirect);
        if (request.method !== 'GET' || url.pathname !== redirect.pathname || url.searchParams.get('state') !== state) {
          response.writeHead(404).end();
          return;
        }
        const received = url.searchParams.get('code');
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(
          received ? '인증 코드를 받았습니다. 터미널에서 연결 결과를 확인하세요.' : 'X 계정 연결이 취소되었습니다.',
          () => finish(received, new Error('X 계정 연결이 취소되었습니다.')),
        );
      });
      const timer = setTimeout(() => finish(null, new Error('X 로그인 대기 시간이 지났습니다.')), 300_000);
      const cancel = () => finish(null, new Error('X 계정 연결이 취소되었습니다.'));
      function finish(value, error) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        server.close();
        server.closeAllConnections();
        if (value) resolve(value);
        else reject(error);
      }
      server.once('error', () => finish(null, new Error('로컬 로그인 포트 53682를 열 수 없습니다.')));
      if (signal?.aborted) return cancel();
      signal?.addEventListener('abort', cancel, { once: true });
      server.listen(Number(redirect.port), redirect.hostname, () => {
        onAuthorize(auth.href);
      });
    });
    const token = await this.exchange({ grant_type: 'authorization_code', code, redirect_uri: redirect.href, code_verifier: verifier });
    const user = await this.profile(token.accessToken);
    const pinned = this.store.get('xAccount');
    if (pinned && pinned !== user.id) throw new Error('이 데이터 폴더는 다른 X 계정에 연결되어 있습니다.');
    verifyAccount?.(user);
    this.store.set('xToken', token);
    return user;
  }

  async token() {
    const token = this.store.get('xToken');
    if (!this.clientId || token?.clientId !== this.clientId) throw new Error('먼저 node sync.mjs auth-x 로 X 계정을 연결하세요.');
    if (Date.now() < token.expiresAt - 60_000) return token.accessToken;
    const refreshed = await this.exchange({ grant_type: 'refresh_token', refresh_token: token.refreshToken }, token);
    this.store.set('xToken', refreshed);
    return refreshed.accessToken;
  }

  async profile(token) {
    const accessToken = token || await this.token();
    const body = await jsonRequest('X 사용자 조회', `${xBase}/users/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    id(body?.data?.id, 'X 사용자');
    return body.data;
  }

  async request(path, data, method = 'POST', accessToken) {
    const headers = { Authorization: `Bearer ${accessToken || await this.token()}` };
    let body = data;
    if (data && !(data instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(data);
    }
    return jsonRequest('X API', `${xBase}/${path}`, { method, headers, body });
  }

  async checkPost(postId, author, parent) {
    const result = await this.request(`tweets/${id(postId, 'X 게시물')}?tweet.fields=author_id,referenced_tweets`, undefined, 'GET');
    const post = result?.data;
    const replyTo = post?.referenced_tweets?.find(reference => reference.type === 'replied_to')?.id;
    if (post?.author_id !== author || (replyTo || null) !== (parent || null)) {
      throw new Error('X 게시물 작성자 또는 답글 대상이 대기 중인 항목과 다릅니다.');
    }
  }

  async create({ text, media, parent, onSend }) {
    const payload = {};
    if (text) payload.text = text;
    if (media.length) payload.media = { media_ids: media };
    if (parent) payload.reply = { in_reply_to_tweet_id: parent };
    const token = await this.token();
    onSend();
    const body = await jsonRequest('X 게시', `${xBase}/tweets`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return id(body?.data?.id, 'X 게시');
  }

  async waitForMedia(mediaId, info) {
    const until = Date.now() + 5 * 60_000;
    while (info && info.state !== 'succeeded') {
      if (info.state === 'failed') throw new Error('X에서 미디어를 처리할 수 없습니다.');
      if (Date.now() >= until) throw new Error('X 미디어 처리 시간이 초과되었습니다.');
      await sleep(Math.min(30, Math.max(1, Number(info.check_after_secs) || 1)) * 1000);
      const status = await this.request(`media/upload?command=STATUS&media_id=${mediaId}`, undefined, 'GET');
      if (!status?.data) throw new Error('X 미디어 처리 상태 응답이 비어 있습니다.');
      info = status.data.processing_info;
    }
    return mediaId;
  }

  async upload(asset, source) {
    const { kind } = asset;
    const url = source.gif_url || source.media_url;
    if (!url) throw new Error('Threads에서 첨부 파일 URL을 제공하지 않았습니다.');
    const directory = await mkdtemp(join(tmpdir(), 'threads-to-x-'));
    const path = join(directory, 'media');
    try {
      const { type, size } = await download(url, path, kind);
      const file = await openAsBlob(path, { type });
      const category = { image: 'tweet_image', gif: 'tweet_gif', video: 'tweet_video' }[kind];
      if (kind === 'image') {
        const form = new FormData();
        form.set('media', file, `media.${type.split('/')[1]}`);
        form.set('media_category', category);
        const response = await this.request('media/upload', form);
        return await this.waitForMedia(id(response?.data?.id, 'X 미디어'), response.data.processing_info);
      }
      const initialized = await this.request('media/upload/initialize', {
        media_type: type, media_category: category, total_bytes: size,
      });
      const mediaId = id(initialized?.data?.id, 'X 미디어');
      const chunk = 4 * 1024 * 1024;
      for (let offset = 0; offset < size; offset += chunk) {
        const form = new FormData();
        form.set('segment_index', String(offset / chunk));
        form.set('media', file.slice(offset, offset + chunk, type), kind === 'gif' ? 'media.gif' : 'media.mp4');
        await this.request(`media/upload/${mediaId}/append`, form);
      }
      const finalized = await this.request(`media/upload/${mediaId}/finalize`);
      if (!finalized?.data) throw new Error('X 미디어 업로드 완료 응답이 비어 있습니다.');
      return await this.waitForMedia(mediaId, finalized.data.processing_info);
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function download(value, path, kind) {
  const max = { image: 5 * 1024 ** 2, gif: 15 * 1024 ** 2, video: 8 * 1024 ** 3 }[kind];
  let url = new URL(value);
  const signal = AbortSignal.timeout(10 * 60_000);
  let response;
  for (let hop = 0; hop < 5; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Threads 첨부 파일 주소가 올바르지 않습니다.');
    try {
      response = await fetch(url, { signal, redirect: 'manual' });
    } catch {
      throw new Error('Threads 첨부 파일 다운로드 연결 실패');
    }
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) break;
    await response.body?.cancel();
    url = new URL(location, url);
  }
  if (!response?.ok || !response.body) throw new Error(`Threads 첨부 파일 다운로드 실패 (HTTP ${response?.status})`);
  let type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if ((!type || type === 'application/octet-stream') && kind === 'video') type = 'video/mp4';
  const allowed = { image: ['image/jpeg', 'image/png', 'image/webp'], gif: ['image/gif'], video: ['video/mp4'] }[kind];
  if (!allowed.includes(type) || Number(response.headers.get('content-length')) > max) {
    await response.body.cancel();
    throw new Error('X에서 지원하는 첨부 파일 형식 또는 용량 범위를 벗어났습니다.');
  }
  let size = 0;
  const meter = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    if (size > max) callback(new Error('첨부 파일이 X 업로드 용량 제한을 초과했습니다.'));
    else callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(path), { signal });
  if (!size) throw new Error('Threads 첨부 파일이 비어 있습니다.');
  return { type, size };
}
