import { execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';
import { Threads, XApi } from './apis.mjs';
import { Store } from './store.mjs';
import { previewPosts } from './sync.mjs';
import { timingEnv, timingValues } from './timing.mjs';
import { assertAccountAvailable, profileIds, profilePaths, profileSummary } from './profiles.mjs';
import { analysisOptions, fetchAnalysis } from './insights.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const csrf = randomBytes(32).toString('hex');
const host = '127.0.0.1';
const port = 53683;
const origin = `http://${host}:${port}`;
const execute = promisify(execFile);
const types = { '/': ['index.html', 'text/html'], '/dashboard.css': ['dashboard.css', 'text/css'], '/client.js': ['client.js', 'text/javascript'], '/insights.js': ['insights.js', 'text/javascript'] };
let authorization;
const taskCache = new Map();
const taskActions = new Set();
let configWrite = Promise.resolve();
let accountWrite = Promise.resolve();
const analysisCache = new Map();

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function config({ id, envFile }) {
  let text;
  try {
    text = await readFile(envFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    text = await readFile(join(root, '.env.example'), 'utf8');
  }
  return { text, env: { ...(id === '1' ? process.env : {}), ...parseEnv(text) } };
}

function saveConfig(profile, updates) {
  const pending = configWrite.then(() => writeConfig(profile, updates));
  configWrite = pending.catch(() => {});
  return pending;
}

async function writeConfig(profile, updates) {
  const { text } = await config(profile);
  const { envFile } = profile;
  const keys = Object.keys(updates);
  const remaining = new Set(keys);
  const lines = text.split(/\r?\n/).flatMap(line => {
    const key = /^\s*(?:export\s+)?([A-Z_]+)\s*=/.exec(line)?.[1];
    if (!keys.includes(key)) return [line];
    if (!remaining.delete(key)) return [];
    return [`${key}=${updates[key]}`];
  });
  for (const key of remaining) lines.push(`${key}=${updates[key]}`);
  const temporary = `${envFile}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${lines.join('\n').trimEnd()}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, envFile);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function credential(value, label, optional = false) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input && optional) return '';
  if (!input || !/^[A-Za-z0-9_.~+:/|=%-]{1,4096}$/.test(input)) {
    throw new RequestError(400, `${label} 값을 확인해 주세요.`);
  }
  return input;
}

async function scheduler(profile, action) {
  const { stdout } = await execute('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); & './windows-task.ps1' -Action ${action} -Profile ${profile.id}`,
  ], { cwd: root, windowsHide: true, timeout: 240_000 });
  return stdout.trim();
}

async function taskState(profile, refresh = false) {
  let cached = taskCache.get(profile.id);
  if (refresh || !cached || Date.now() >= cached.until) {
    cached = { until: Date.now() + 4500, value: scheduler(profile, 'Inspect').then(JSON.parse).catch(() => ({ unavailable: true })) };
    taskCache.set(profile.id, cached);
  }
  return cached.value;
}

function connected(store, env) {
  const token = env.THREADS_ACCESS_TOKEN;
  const t = store.get('threadsConnection');
  const threadsReady = Boolean(token && t?.fingerprint === createHash('sha256').update(token).digest('hex'));
  const xReady = Boolean(env.X_CLIENT_ID && store.get('xToken')?.clientId === env.X_CLIENT_ID && store.get('xAccount'));
  return {
    threads: { ready: threadsReady, saved: Boolean(token), username: threadsReady ? t.username : null },
    x: { ready: xReady, clientId: env.X_CLIENT_ID || '', hasSecret: Boolean(env.X_CLIENT_SECRET), username: xReady ? store.get('xUsername') : null },
  };
}

async function dashboard(profile, store) {
  const [{ env }, task, primary] = await Promise.all([
    config(profile), taskState(profile), profile.id === '1' ? null : config(profilePaths(root, '1')),
  ]);
  const connections = connected(store, env);
  if (!connections.x.clientId && primary?.env.X_CLIENT_ID) {
    connections.x.suggestedClientId = primary.env.X_CLIENT_ID;
    connections.x.suggestedHasSecret = Boolean(primary.env.X_CLIENT_SECRET);
  }
  const profiles = profileIds.map(id => {
    const { label, threads, x } = profileSummary(root, id);
    return { id, label, threads, x };
  });
  return {
    csrf, profile: profile.id, profiles, connections, task,
    settings: { ...timingValues(env), since: env.SYNC_FROM || '', started: store.get('syncFrom') },
    counts: Object.fromEntries(store.counts().map(row => [row.state, row.count])),
    activity: store.activity().map(({ payload, ...row }) => {
      const data = JSON.parse(payload);
      return { ...row, text: data.text, mediaCount: data.media.length };
    }),
    sourceErrors: store.sourceErrors(), lastChecked: store.get('discoveredThrough'),
    auth: authorization?.profile === profile.id ? { state: authorization.state, url: authorization.url, error: authorization.error } : null,
  };
}

async function withLock(store, fn) {
  const release = store.lock();
  try { return await fn(); } finally { release(); }
}

function saveAccount(profile, platform, user, action) {
  const pending = accountWrite.then(async () => {
    assertAccountAvailable(root, profile.id, platform, user);
    await action();
  });
  accountWrite = pending.catch(() => {});
  return pending;
}

async function connectThreads(profile, store, body) {
  return withLock(store, async () => {
    const { env } = await config(profile);
    const token = credential(body.token || env.THREADS_ACCESS_TOKEN, 'Threads 사용자 토큰');
    const secret = credential(body.token ? body.secret : env.THREADS_APP_SECRET, 'Threads 앱 시크릿', true);
    const changes = new Map();
    const draft = { get: key => changes.has(key) ? changes.get(key) : store.get(key), set: (key, value) => changes.set(key, value) };
    const threads = new Threads(draft, { THREADS_ACCESS_TOKEN: token, THREADS_APP_SECRET: secret });
    const user = await threads.profile();
    if (store.get('threadsAccount') && store.get('threadsAccount') !== user.id) {
      throw new RequestError(409, '이 동기화 기록에 연결된 Threads 계정으로 다시 인증해 주세요.');
    }
    const [post] = await threads.posts(undefined, undefined, 1);
    if (post) await threads.replies(post.id);
    await saveAccount(profile, 'threads', user, async () => {
      await saveConfig(profile, { THREADS_ACCESS_TOKEN: token, THREADS_APP_SECRET: secret });
      store.transaction(() => {
        for (const [key, value] of changes) store.set(key, value);
        store.set('threadsConnection', { id: user.id, username: user.username, fingerprint: createHash('sha256').update(token).digest('hex') });
      });
    });
    return { username: user.username, repliesChecked: Boolean(post) };
  });
}

async function connectX(profile, body) {
  if (authorization?.state === 'pending') throw new RequestError(409, '이미 X 로그인 승인을 기다리고 있습니다.');
  const { env } = await config(profile);
  const clientId = credential(body.clientId, 'X Client ID');
  const primary = profile.id === '1' ? env : (await config(profilePaths(root, '1'))).env;
  const savedSecret = (clientId === env.X_CLIENT_ID && env.X_CLIENT_SECRET)
    || (clientId === primary.X_CLIENT_ID && primary.X_CLIENT_SECRET);
  const secret = credential(body.publicClient ? '' : body.secret || savedSecret, 'X Client Secret', true);
  if (authorization?.state === 'pending') throw new RequestError(409, '이미 X 로그인 승인을 기다리고 있습니다.');
  const store = new Store(profile.directory);
  let release;
  try { release = store.lock(); } catch (error) { store.close(); throw error; }
  const attempt = { profile: profile.id, state: 'pending', controller: new AbortController() };
  authorization = attempt;
  const x = new XApi(store, { X_CLIENT_ID: clientId, X_CLIENT_SECRET: secret });
  // Save the active OAuth settings only after X verifies the account.
  const draft = new Map();
  x.store = {
    get(key) {
      if (key === 'xAccount' && !store.get('syncFrom')) return undefined;
      return draft.has(key) ? draft.get(key) : store.get(key);
    },
    set: (key, value) => draft.set(key, value),
  };
  let ready;
  const urlReady = new Promise(resolve => { ready = resolve; });
  void x.login({ signal: attempt.controller.signal, onAuthorize(url) { attempt.url = url; ready(); } })
    .then(async user => {
      await saveAccount(profile, 'x', user, async () => {
        await saveConfig(profile, { X_CLIENT_ID: clientId, X_CLIENT_SECRET: secret });
        store.transaction(() => {
          store.set('xAccount', user.id);
          store.set('xUsername', user.username);
          for (const [key, value] of draft) store.set(key, value);
          store.set('xRetryAt', 0);
        });
      });
      attempt.state = 'done';
    })
    .catch(error => { attempt.state = 'failed'; attempt.error = error.message; })
    .finally(() => { delete attempt.url; release(); store.close(); ready(); });
  await urlReady;
  if (!attempt.url) throw new RequestError(400, attempt.error || 'X 로그인 창을 시작하지 못했습니다.');
  return { url: attempt.url };
}

async function saveSettings(profile, store, body) {
  const updates = timingEnv(body);
  if (!store.get('syncFrom')) {
    const since = body.since ? `${body.since}:00+09:00` : '';
    const value = Date.parse(since);
    if (since && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:00\+09:00$/.test(since) || !Number.isFinite(value) || value > Date.now() || value < 1688540400 * 1000)) {
      throw new RequestError(400, '첫 게시 시각을 한국 시간으로 올바르게 입력해 주세요.');
    }
    updates.SYNC_FROM = since;
  }
  await saveConfig(profile, updates);
  return {};
}

async function changeTask(profile, store, action) {
  if (taskActions.has(profile.id)) throw new RequestError(409, 'Windows 작업 상태를 변경하고 있습니다.');
  taskActions.add(profile.id);
  try {
    const status = await taskState(profile, true);
    if (status.unavailable) throw new RequestError(503, '이 PC에서 Windows 작업 스케줄러를 확인할 수 없습니다.');
    if (action === 'stop' && status.running) await scheduler(profile, 'Pause');
    if (action === 'start' && !status.running) {
      const { env } = await config(profile);
      const { threads, x } = connected(store, env);
      if (!threads.ready || !x.ready) throw new RequestError(409, 'Threads와 X를 먼저 연결해 주세요.');
      await scheduler(profile, status.installed ? 'Start' : 'Install');
    }
    return await taskState(profile, true);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    const detail = (error.stderr || error.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0];
    throw new RequestError(400, detail ? `Windows 작업 처리 실패 · ${detail}` : 'Windows 작업을 변경하지 못했습니다.');
  } finally {
    taskActions.delete(profile.id);
  }
}

async function resolveActivity(profile, store, body) {
  return withLock(store, async () => {
    const key = typeof body.key === 'string' && /^\d+:\d+$/.test(body.key) ? body.key : '';
    const row = key && store.review(key);
    if (!row || !['manual', 'blocked', 'review'].includes(row.state)) throw new RequestError(409, '처리가 필요한 게시 항목을 선택해 주세요.');
    if (body.action === 'retry') {
      store.retry(key);
      store.set('xRetryAt', 0);
      return {};
    }
    const value = String(body.url || '').trim();
    const id = /^\d+$/.test(value) ? value : /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[^?#]+\/status\/(\d+)(?:[/?#]|$)/i.exec(value)?.[1];
    if (body.action !== 'posted' || !id || (row.parent && !row.parent_x_id)) throw new RequestError(400, '게시한 X 글의 주소를 입력해 주세요.');
    const { env } = await config(profile);
    await new XApi(store, env).checkPost(id, store.get('xAccount'), row.parent_x_id);
    store.posted(key, id);
    return {};
  });
}

async function analyze(profile, store, body) {
  const options = analysisOptions(body);
  const { env } = await config(profile);
  if (!connected(store, env).x.ready) throw new RequestError(409, '이 연결의 X 계정을 먼저 연결해 주세요.');
  const key = JSON.stringify([profile.id, store.get('xAccount'), env.X_CLIENT_ID, options]);
  const saved = analysisCache.get(key);
  const now = Date.now();
  if (saved?.expires > now) return { ...await saved.result, cached: true };
  const x = new XApi(store, env);
  const result = (async () => {
    try {
      const accessToken = await withLock(store, () => x.token());
      return await fetchAnalysis(path => x.request(path, undefined, 'GET', accessToken), options, now);
    } catch (error) {
      if (error.status === 401) throw new RequestError(401, 'X 연결이 만료되었습니다. 계정 연결 화면에서 다시 승인해 주세요.');
      if (error.status === 402) throw new RequestError(402, 'X API 크레딧이 부족합니다. X 개발자 콘솔에서 잔액을 확인해 주세요.');
      if (error.status === 429) throw new RequestError(429, 'X API 조회 한도에 도달했습니다. 잠시 후 다시 분석해 주세요.');
      throw error;
    }
  })();
  analysisCache.set(key, { expires: now + 15 * 60_000, result });
  if (analysisCache.size > 30) analysisCache.delete(analysisCache.keys().next().value);
  try {
    return await result;
  } catch (error) {
    if (analysisCache.get(key)?.result === result) analysisCache.delete(key);
    throw error;
  }
}

async function bodyOf(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 16_384) throw new RequestError(413, '입력 내용이 너무 깁니다.');
  }
  try {
    const body = JSON.parse(raw);
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  throw new RequestError(400, '입력 내용을 읽을 수 없습니다.');
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
  if (request.headers.host !== `${host}:${port}`) return json(response, 403, { error: '이 PC의 로컬 주소로 열어 주세요.' });
  const path = request.url.split('?')[0];
  let store;
  try {
    if (request.method === 'GET' && types[path]) {
      const [file, type] = types[path];
      const content = await readFile(join(root, 'ui', file));
      response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }).end(content);
      return;
    }
    if (request.method === 'GET' && path === '/favicon.ico') return response.writeHead(204).end();
    const profileId = request.headers['x-relay-profile'] ?? '1';
    if (!profileIds.includes(profileId)) throw new RequestError(400, '계정 연결은 1~5번 중에서 선택해 주세요.');
    const profile = profilePaths(root, profileId);
    if (request.method === 'GET' && path === '/api/state') {
      store = new Store(profile.directory);
      return json(response, 200, await dashboard(profile, store));
    }
    if (request.method !== 'POST') return json(response, 404, { error: '페이지를 찾을 수 없습니다.' });
    if (request.headers.origin !== origin || request.headers['x-relay-token'] !== csrf || !request.headers['content-type']?.startsWith('application/json')) {
      return json(response, 403, { error: '설정 화면을 다시 열고 시도해 주세요.' });
    }
    const body = await bodyOf(request);
    store = new Store(profile.directory);
    let result;
    switch (path) {
      case '/api/threads': result = await connectThreads(profile, store, body); break;
      case '/api/x': result = await connectX(profile, body); break;
      case '/api/x/cancel':
        if (authorization?.profile === profile.id) authorization.controller.abort();
        result = {};
        break;
      case '/api/profile': {
        const label = typeof body.label === 'string' ? body.label.trim() : '';
        if (label.length > 36 || /[\r\n\t]/.test(label)) throw new RequestError(400, '연결 이름은 36자 이하로 입력해 주세요.');
        store.set('profileLabel', label);
        result = {};
        break;
      }
      case '/api/settings': result = await saveSettings(profile, store, body); break;
      case '/api/automation/start': result = await changeTask(profile, store, 'start'); break;
      case '/api/automation/stop': result = await changeTask(profile, store, 'stop'); break;
      case '/api/activity': result = await resolveActivity(profile, store, body); break;
      case '/api/insights': result = await analyze(profile, store, body); break;
      case '/api/preview': result = await withLock(store, async () => {
        const { env } = await config(profile);
        const threads = new Threads(store, env);
        return previewPosts(threads, await threads.profile(), 3);
      }); break;
      default: throw new RequestError(404, '기능을 찾을 수 없습니다.');
    }
    return json(response, 200, result);
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 400;
    const message = String(error.message || '요청을 처리하지 못했습니다.');
    return json(response, status, { error: message });
  } finally {
    store?.close();
  }
});

function openBrowser() {
  if (process.argv.includes('--open')) {
    execFile('explorer.exe', [origin], { windowsHide: true }, () => {});
  }
}

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.log(`이미 열려 있습니다. ${origin}`);
    openBrowser();
    return;
  }
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`Relay 설정 화면 ${origin}`);
  openBrowser();
});
