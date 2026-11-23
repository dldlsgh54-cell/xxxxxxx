import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError, Threads, XApi } from './apis.mjs';
import { hasCoupon, plan } from './content.mjs';
import { Store } from './store.mjs';
import { due, loadTiming } from './timing.mjs';
import { assertAccountAvailable, profilePaths } from './profiles.mjs';

const minute = 60_000;
const day = 24 * 60 * minute;
const project = fileURLToPath(new URL('.', import.meta.url));
const permalink = id => `https://x.com/i/web/status/${id}`;

function errorText(error) { return error instanceof Error ? error.message : String(error); }

function setLogging(directory) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'worker.log');
  for (const level of ['log', 'warn', 'error']) {
    const output = console[level].bind(console);
    console[level] = (...values) => {
      output(...values);
      try {
        if (existsSync(file) && statSync(file).size >= 2_000_000) renameSync(file, join(directory, 'worker.previous.log'));
        appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase()} ${values.join(' ')}\n`);
      } catch (error) {
        output(`로그 저장 실패 — ${errorText(error)}`);
      }
    };
  }
}

async function discover(store, threads, started) {
  const now = Date.now();
  const from = Math.max(started, (store.get('discoveredThrough') || started) - 60 * minute);
  if (Math.floor(from / 1000) >= Math.floor(now / 1000)) return;
  const posts = await threads.posts(from, now);
  for (const post of posts) {
    if (!/^\d+$/.test(post.id) || !Number.isFinite(Date.parse(post.timestamp))) throw new Error('Threads 게시물 ID 또는 게시 시간이 비어 있습니다.');
  }
  store.discover(posts.filter(post => Date.parse(post.timestamp) >= started && !post.is_reply), now);
}

async function queueRootPosts(store, threads) {
  for (const root of store.unplanned(Date.now())) {
    try {
      const post = await threads.post(root.id);
      store.addPlan(root.id, root.id, post.permalink, plan(post, await threads.children(post)));
    } catch (error) {
      store.planFailed(root.id, errorText(error), Math.max(Date.now() + 5 * minute, error.retryAt || 0));
      console.warn(`Threads ${root.id} 본문 확인 실패 — ${errorText(error)}`);
      if (error.status === 429) throw error;
    }
  }
}

async function couponReplies(threads, rootId, username, known = () => false) {
  const selected = [];
  const replies = await threads.replies(rootId);
  for (const reply of replies) {
    const owned = reply.is_reply_owned_by_me ?? (reply.username && username && reply.username.toLowerCase() === username.toLowerCase());
    if (!owned || ![undefined, null, 'NOT_HUSHED', 'UNHUSHED'].includes(reply.hide_status) || known(reply.id)) continue;
    const details = await threads.post(reply.id);
    const full = { ...reply, ...details };
    if (hasCoupon(full)) selected.push(full);
  }
  return selected.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

async function queueReplies(store, threads, username, { lookback, replyInterval }) {
  const now = Date.now();
  for (const root of store.forReplies(now, now - lookback * day, replyInterval * 1000)) {
    try {
      for (const reply of await couponReplies(threads, root.id, username, item => store.hasItem(item))) {
        store.addPlan(root.id, reply.id, reply.permalink, plan(reply, await threads.children(reply)));
      }
      store.replyChecked(root.id, Date.now());
    } catch (error) {
      store.replyFailed(root.id, Math.max(Date.now() + 5 * minute, error.retryAt || 0), errorText(error));
      console.warn(`Threads ${root.id} 댓글 확인 실패 — ${errorText(error)}`);
      if (error.status === 429) throw error;
    }
  }
}

async function publish(store, threads, x, singleRoot = false) {
  if ((store.get('xRetryAt') || 0) > Date.now()) return;
  let root = null;
  for (let index = 0; index < 20; index++) {
    const row = store.ready(Date.now(), root);
    if (!row) break;
    if (singleRoot) root = row.root;
    const payload = JSON.parse(row.payload);
    let sent = false;
    try {
      const media = [];
      for (const asset of payload.media) media.push(await x.upload(asset, await threads.asset(asset.id)));
      const xId = await x.create({
        text: payload.text, media, parent: row.parent_x_id,
        onSend() {
          store.sending(row.key);
          sent = true;
        },
      });
      store.posted(row.key, xId);
      console.log(`${row.key} 게시 완료 — ${permalink(xId)}`);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : undefined;
      let state = 'pending';
      if (sent && (!status || status >= 500 || status === 408 || status === 409)) state = 'review';
      else if (sent && row.parent && [400, 403, 404].includes(status)) state = 'manual';
      else if (sent && [400, 403, 404, 413, 422].includes(status)) state = 'blocked';
      const delay = Math.min(60, 2 ** Math.min(6, row.attempts)) * minute;
      const retryAt = Math.max(Date.now() + delay, error.retryAt || 0);
      store.failed(row.key, state, errorText(error), retryAt, sent);
      console.warn(`${row.key} ${state} — ${errorText(error)}`);
      if ([401, 402, 429].includes(status)) {
        store.set('xRetryAt', retryAt);
        break;
      }
    }
  }
}

function publishSlotDue(store, interval, now) {
  return due(store.get('lastPublishRun') || store.get('syncFrom'), interval, now)
    && (store.get('xRetryAt') || 0) <= now;
}

async function publishQueued(store, threads, x, interval) {
  const now = Date.now();
  if (!publishSlotDue(store, interval, now) || !store.ready(now)) return false;
  store.set('lastPublishRun', now);
  try {
    await publish(store, threads, x, interval > 0);
  } finally {
    store.set('lastPublishRun', Date.now());
  }
  return true;
}

function printStatus(store) {
  const started = store.get('syncFrom');
  if (started) console.log(`감지 시작 시각 ${new Date(started).toISOString()}`);
  const counts = store.counts();
  console.log(counts.length ? counts.map(row => `${row.state} ${row.count}건`).join(' / ') : '대기 중인 게시물이 없습니다.');
  for (const row of store.queued()) {
    const payload = JSON.parse(row.payload);
    console.log(`\n${row.key} [${row.state}]${row.error ? ` ${row.error}` : ''}`);
    if (row.parent_x_id) console.log(`답글 대상 ${permalink(row.parent_x_id)}`);
    else if (row.parent) console.log(`이전 항목 대기 ${row.parent}`);
    if (row.source) console.log(`Threads 원문 ${row.source}`);
    if (payload.text) console.log(payload.text);
    if (payload.media.length) console.log(`첨부 파일 ${payload.media.length}개`);
  }
  for (const row of store.sourceErrors()) console.warn(`Threads ${row.id} — ${[row.plan_error, row.reply_error].filter(Boolean).join(' / ')}`);
}

function scheduledWork(store, timing, once, discoveryRetryAt, now) {
  const savedStart = store.get('syncFrom');
  const discoverNow = once || (now >= discoveryRetryAt && due(store.get('discoveredThrough'), timing.interval, now));
  const plansDue = once || store.unplanned(now, 1).length > 0;
  const repliesDue = once || store.forReplies(now, now - timing.lookback * day, timing.replyInterval * 1000, 1).length > 0;
  const publishDue = publishSlotDue(store, timing.publishInterval, now);
  if (savedStart && !discoverNow && !plansDue && !repliesDue && !(publishDue && store.ready(now))) return null;
  return { savedStart, discoverNow, plansDue, repliesDue, publishDue };
}

async function previewPosts(threads, user, limit) {
  const posts = await threads.posts(undefined, undefined, limit);
  const preview = [];
  for (const post of posts) {
    const replies = [];
    const parts = plan(post, await threads.children(post));
    for (const reply of await couponReplies(threads, post.id, user.username)) {
      replies.push(...plan(reply, await threads.children(reply)));
    }
    preview.push({ id: post.id, permalink: post.permalink, parts, replies });
  }
  return preview;
}

async function preview(threads, user, limit) {
  const posts = await previewPosts(threads, user, limit);
  for (const post of posts) {
    console.log(`\nThreads ${post.permalink || post.id}`);
    for (const [index, part] of post.parts.entries()) {
      console.log(`${index ? '이어지는 답글' : 'X 본문'}${part.media.length ? ` · 첨부 ${part.media.length}개` : ''}\n${part.text}`);
    }
    for (const part of post.replies) {
      console.log(`쿠팡 링크 답글${part.media.length ? ` · 첨부 ${part.media.length}개` : ''}\n${part.text}`);
    }
  }
  if (!posts.length) console.log('Threads 게시물을 찾지 못했습니다.');
}

const help = `Threads → X 자동 게시
  node sync.mjs auth-x                    X 로그인 연결
  node sync.mjs check                     Threads/X 계정과 댓글 조회 확인
  node sync.mjs preview --limit 3         실제 게시 없이 미리보기
  node sync.mjs once                      한 차례 실제 동기화
  node sync.mjs run                       자동 동기화 시작
  node sync.mjs status                    대기열과 오류 확인
  node sync.mjs posted <항목ID> <X ID/URL> 수동 게시 또는 전송 확인 결과 기록
  node sync.mjs retry <항목ID>            X에 올라가지 않은 항목 다시 대기열에 추가
  --profile <1~5>                        사용할 계정 연결 번호 (기본 1)`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    limit: { type: 'string', default: '3' }, profile: { type: 'string', default: '1' }, help: { type: 'boolean', short: 'h' },
  } });
  const [command, key, xPost, ...rest] = positionals;
  if (values.help || !command || command === 'help') {
    console.log(help);
    return;
  }
  const { id, directory, envFile: envPath } = profilePaths(project, values.profile);
  const env = id === '1' ? process.env : {};
  if (existsSync(envPath)) {
    if (id === '1') process.loadEnvFile(envPath);
    else Object.assign(env, parseEnv(readFileSync(envPath, 'utf8')));
  }
  if (command === 'run') setLogging(directory);
  const store = new Store(directory);
  const threads = new Threads(store, env);
  const x = new XApi(store, env);
  let unlock;
  try {
    if (command === 'status') return printStatus(store);
    if (command !== 'run') unlock = store.lock();
    if (command === 'auth-x') {
      const user = await x.login({ verifyAccount: user => assertAccountAvailable(project, id, 'x', user) });
      store.pin('xAccount', user.id);
      store.set('xUsername', user.username);
      store.set('xRetryAt', 0);
      console.log(`X @${user.username} 연결 완료`);
      return;
    }
    if (command === 'retry') {
      if (!key || xPost || !store.retry(key)) throw new Error('다시 보낼 대기 항목 ID를 입력하세요.');
      store.set('xRetryAt', 0);
      console.log(`${key} 재시도 대기 중`);
      return;
    }
    if (command === 'posted') {
      const xId = /^\d+$/.test(xPost || '') ? xPost : /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[^?#]+\/status\/(\d+)(?:[/?#]|$)/i.exec(xPost || '')?.[1];
      const row = key && store.review(key);
      if (rest.length || !xId || !row || row.state === 'posted' || (row.parent && !row.parent_x_id)) throw new Error('대기 항목 ID와 실제 X 게시물 주소를 입력하세요.');
      const account = store.get('xAccount');
      if (!account) throw new Error('먼저 X 계정을 연결하세요.');
      await x.checkPost(xId, account, row.parent_x_id);
      store.posted(key, xId);
      console.log(`${key} 게시 완료 — ${permalink(xId)}`);
      return;
    }
    if (command === 'preview' || command === 'check') {
      const count = Number(values.limit);
      if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('--limit은 1~20으로 지정하세요.');
      const user = await threads.profile();
      console.log(`Threads @${user.username}`);
      if (command === 'preview') return await preview(threads, user, count);
      const target = await x.profile();
      const posts = await threads.posts(undefined, undefined, 1);
      if (posts[0]) {
        await threads.replies(posts[0].id);
        console.log('Threads 댓글 조회 성공');
      }
      console.log(`X @${target.username} 조회 성공`);
      return;
    }
    if (!['run', 'once'].includes(command) || key) throw new Error(`알 수 없는 명령입니다.\n${help}`);
    let timing = loadTiming(envPath, env);
    const start = env.SYNC_FROM ? Date.parse(env.SYNC_FROM) : null;
    if (start !== null && (!Number.isFinite(start) || start < 1688540400 * 1000 || start > Date.now())) {
      throw new Error('SYNC_FROM에 유효한 과거 날짜와 시간대를 입력하세요.');
    }
    if (!env.THREADS_ACCESS_TOKEN || !store.get('xAccount')) throw new Error('Threads 토큰 설정과 X 계정 연결이 필요합니다.');
    if (!env.X_CLIENT_ID || store.get('xToken')?.clientId !== env.X_CLIENT_ID) throw new Error('현재 Client ID로 X 계정을 다시 연결하세요.');
    const once = command === 'once';
    let discoveryRetryAt = 0;
    let blockedUntil = 0;
    let timingError;
    if (!once) console.log(`자동 동기화 시작 · 새 글 ${timing.interval}초 · 댓글 ${timing.replyInterval}초 · X 게시 ${timing.publishInterval || '즉시'}`);
    for (;;) {
      let release;
      try {
        if (!once) {
          await sleep(1000);
          try {
            timing = loadTiming(envPath, env);
            timingError = undefined;
          } catch (error) {
            if (timingError !== errorText(error)) console.warn(`이전 동기화 주기를 계속 사용합니다. ${errorText(error)}`);
            timingError = errorText(error);
          }
        }
        const now = Date.now();
        if (now < blockedUntil) continue;
        const work = scheduledWork(store, timing, once, discoveryRetryAt, now);
        if (!work) continue;
        if (!once) release = store.lock();
        const currentWork = once ? work : scheduledWork(store, timing, once, discoveryRetryAt, Date.now());
        if (!currentWork) continue;
        const { savedStart, discoverNow, plansDue, repliesDue } = currentWork;

        const user = await threads.profile();
        if (!store.get('threadsAccount')) assertAccountAvailable(project, id, 'threads', user);
        store.pin('threadsAccount', user.id);
        if (store.get('threadsUsername') !== user.username) store.set('threadsUsername', user.username);
        const started = savedStart ?? Math.floor((start ?? Date.now()) / 1000) * 1000;
        if (!savedStart) {
          store.set('syncFrom', started);
          console.log(`이 시점부터 게시물을 동기화합니다. ${new Date(started).toISOString()}`);
        }

        const published = await publishQueued(store, threads, x, timing.publishInterval);
        let discoveryError;
        if (discoverNow) {
          try {
            await discover(store, threads, started);
          } catch (error) {
            if (error.status === 429) throw error;
            console.warn(`새 Threads 게시물 확인 실패 — ${errorText(error)}`);
            discoveryError = error;
            discoveryRetryAt = Date.now() + minute;
          }
        }
        if (discoverNow || plansDue) await queueRootPosts(store, threads);
        if (discoverNow || plansDue || repliesDue) await queueReplies(store, threads, user.username, timing);
        if (!published) await publishQueued(store, threads, x, timing.publishInterval);
        if (once) {
          printStatus(store);
          if (discoveryError) throw discoveryError;
          return;
        }
      } catch (error) {
        if (once) throw error;
        console.warn(errorText(error));
        blockedUntil = Math.max(Date.now() + (error.status === 429 ? minute : 15_000), error.retryAt || 0);
      } finally {
        release?.();
      }
    }
  } finally {
    unlock?.();
    store.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(errorText(error));
    process.exitCode = 1;
  });
}

export { couponReplies, previewPosts, publish, publishQueued, scheduledWork };
