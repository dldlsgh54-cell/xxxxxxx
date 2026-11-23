import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import twitterText from 'twitter-text';
import { ApiError, Threads, XApi } from './apis.mjs';
import { hasCoupon, plan, splitText } from './content.mjs';
import { Store } from './store.mjs';
import { couponReplies, publish, publishQueued, scheduledWork } from './sync.mjs';
import { loadTiming, timingEnv } from './timing.mjs';
import { assertAccountAvailable, profileIds, profilePaths, profileSummary } from './profiles.mjs';

const coupon = 'https://link.coupang.com/a/demo?source=threads&ref=sample';

function withStore(t) {
  const folder = mkdtempSync(join(tmpdir(), 'threads-sync-test-'));
  const store = new Store(folder);
  t.after(() => {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  });
  return store;
}

test('reloads and applies independent check and publish intervals to pending work', t => {
  const store = withStore(t);
  const now = Date.parse('2026-11-23T00:00:00Z');
  const envFile = join(store.directory, '.env');
  store.set('syncFrom', now);
  store.set('lastPublishRun', now);
  store.discover([{ id: '100', timestamp: new Date(now).toISOString() }], now);
  store.addPlan('100', '100', null, plan({ text: '본문' }));
  store.replyChecked('100', now);
  writeFileSync(envFile, 'POLL_SECONDS=45\nREPLY_POLL_SECONDS=90\nX_PUBLISH_SECONDS=120\n');
  const initial = loadTiming(envFile, {});
  assert.equal(scheduledWork(store, initial, false, 0, now + 15_000), null);
  const newPostCheck = scheduledWork(store, initial, false, 0, now + 45_000);
  assert.equal(newPostCheck.discoverNow, true);
  assert.equal(newPostCheck.repliesDue, false);
  assert.equal(newPostCheck.publishDue, false);
  store.set('discoveredThrough', now + 45_000);

  writeFileSync(envFile, 'POLL_SECONDS=300\nREPLY_POLL_SECONDS=15\nX_PUBLISH_SECONDS=0\n');
  const updated = loadTiming(envFile, { X_PUBLISH_SECONDS: '999' });
  const faster = scheduledWork(store, updated, false, 0, now + 46_000);
  assert.equal(faster.discoverNow, false);
  assert.equal(faster.repliesDue, true);
  assert.equal(faster.publishDue, true);
  assert.throws(() => timingEnv({ ...updated, replyInterval: 0 }), /쿠팡 댓글 확인 주기/);
});

test('preserves existing reply retry timing and checks old imports once', t => {
  const store = withStore(t);
  const now = Date.parse('2026-11-23T00:00:00Z');
  const yesterday = now - 86_400_000;
  store.discover([{ id: '100', timestamp: new Date(yesterday - 1).toISOString() }], now);
  store.addPlan('100', '100', null, plan({ text: '이전 본문' }));
  assert.equal(store.forReplies(now, yesterday, 300_000).length, 1);
  store.replyFailed('100', now + 300_000, '429');
  assert.equal(store.forReplies(now + 15_000, yesterday, 15_000).length, 0);
  assert.equal(store.forReplies(now + 300_000, yesterday, 15_000).length, 1);
  store.replyChecked('100', now + 300_000);
  assert.equal(store.forReplies(now + 600_000, yesterday, 15_000).length, 0);
});

test('publishes one root per interval in discovery order and attaches its queued replies', async t => {
  const store = withStore(t);
  const now = Date.parse('2026-11-23T00:00:00Z');
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const post = (id, offset) => ({ id, timestamp: new Date(now + offset).toISOString() });

  store.discover([post('102', 20), post('101', 10)], now + 25);
  assert.deepEqual(store.unplanned(now).map(row => row.id), ['101', '102']);
  for (const root of store.unplanned(now)) store.addPlan(root.id, root.id, null, plan({ text: `본문 ${root.id}` }));
  store.addPlan('101', '111', null, plan({ text: coupon }));
  store.discover([post('100', 0)], now + 30);
  store.addPlan('100', '100', null, plan({ text: '뒤늦게 확인된 본문' }));

  const calls = [];
  const x = {
    async create({ text, parent, onSend }) {
      onSend();
      calls.push({ text, parent });
      clock += 2000;
      return String(900 + calls.length);
    },
  };
  assert.equal(await publishQueued(store, {}, x, 60), true);
  assert.deepEqual(calls, [{ text: '본문 101', parent: null }, { text: coupon, parent: '901' }]);
  clock = now + 63_999;
  assert.equal(await publishQueued(store, {}, x, 60), false);
  clock++;
  assert.equal(await publishQueued(store, {}, x, 60), true);
  assert.equal(calls.at(-1).text, '본문 102');
  assert.equal(await publishQueued(store, {}, x, 0), true);
  assert.equal(calls.at(-1).text, '뒤늦게 확인된 본문');
});

test('isolates account settings and posts each Coupang reply under its own X account root', async t => {
  const fixture = withStore(t);
  const project = fixture.directory;
  assert.equal(profilePaths(project, '1').directory, join(project, 'data'));
  assert.equal(new Set(profileIds.map(id => profilePaths(project, id).envFile)).size, 5);
  assert.throws(() => profilePaths(project, '../5'), /1~5/);
  const primary = new Store(profilePaths(project, '1').directory);
  const other = new Store(profilePaths(project, '2').directory);
  try {
    primary.set('profileLabel', '생활용품');
    primary.set('xAccount', '900');
    primary.set('xUsername', 'home');
    primary.set('threadsConnection', { id: '201', username: 'home_threads' });
    other.set('xAccount', '910');
    assert.equal(profileSummary(project, '1').label, '생활용품');
    assert.equal(profileSummary(project, '2').threads, undefined);
    assert.throws(() => assertAccountAvailable(project, '2', 'x', { id: '900', username: 'home' }), /생활용품/);
    assert.throws(() => assertAccountAvailable(project, '2', 'threads', { id: 'fake-other-app-id', username: 'HOME_THREADS' }), /생활용품/);
    const parents = [];
    for (const [store, xRoot] of [[primary, '1234'], [other, '5678']]) {
      store.discover([{ id: '100', timestamp: new Date().toISOString() }], Date.now());
      store.addPlan('100', '100', null, plan({ text: '원본 글' }));
      store.addPlan('100', '101', null, plan({ text: coupon }));
      store.posted('100:0', xRoot);
      await publish(store, {}, {
        async create({ parent, onSend }) { onSend(); parents.push(parent); return `${xRoot}9`; },
      });
    }
    assert.deepEqual(parents, ['1234', '5678']);
    assert.equal(primary.get('xAccount'), '900');
    assert.equal(other.get('xAccount'), '910');
  } finally {
    primary.close();
    other.close();
  }
});

test('preserves Korean comment and referral link, and splits weighted text without breaking links or emoji', () => {
  const comment = `할인가 확인\n${coupon}`;
  assert.deepEqual(splitText(comment), [comment]);
  const parts = splitText(`${'가나다라마'.repeat(38)} 👋🏽 ${coupon} 추가 상품 안내`);
  assert.ok(parts.every(part => twitterText.parseTweet(part).valid));
  assert.ok(parts.some(part => part.includes(`👋🏽 ${coupon}`)));
  assert.ok(hasCoupon({ link_attachment_url: 'https://coupa.ng/demo' }));
  assert.equal(hasCoupon({ text: 'https://coupang.com.example.com/demo' }), false);
  assert.equal(hasCoupon({ text: 'https://example.com?url=https%3A%2F%2Fcoupang.com' }), false);
});

test('keeps mixed carousel order and uses X attachment group limits', () => {
  const children = ['IMAGE', 'IMAGE', 'IMAGE', 'IMAGE', 'IMAGE', 'VIDEO', 'IMAGE'].map((media_type, index) => ({ id: String(index), media_type }));
  assert.deepEqual(plan({ text: '사진과 영상' }, children).map(part => part.media.map(media => media.id)), [
    ['0', '1', '2', '3'], ['4'], ['5'], ['6'],
  ]);
});

test('copies only visible account-owned Coupang replies, including links in attachments', async () => {
  const threads = {
    async replies() {
      return [
        { id: '1', is_reply_owned_by_me: true, text: coupon },
        { id: '2', is_reply_owned_by_me: false, username: 'demo', text: coupon },
        { id: '3', is_reply_owned_by_me: true, hide_status: 'HIDDEN', text: coupon },
        { id: '4', username: 'DEMO', text: '할인 링크' },
        { id: '5', username: 'other', text: coupon },
        { id: '6', username: 'demo', text: '일반 댓글' },
      ];
    },
    async post(id) { return id === '4' ? { link_attachment_url: coupon } : {}; },
  };
  assert.deepEqual((await couponReplies(threads, '100', 'demo', id => id === '1')).map(reply => reply.id), ['4']);
});

test('deduplicates roots, attaches late coupon replies to the saved X root, and preserves forbidden replies', async t => {
  const store = withStore(t);
  const timestamp = new Date().toISOString();
  store.discover([{ id: '100', timestamp }], Date.now());
  store.addPlan('100', '100', null, plan({ text: '본 게시물' }));
  const calls = [];
  const x = {
    async create({ text, parent, onSend }) {
      onSend();
      calls.push({ text, parent });
      if (parent) throw new ApiError('X', new Response(null, { status: 403 }), { detail: 'Reply is not permitted' });
      return '900';
    },
  };
  await publish(store, {}, x);
  store.discover([{ id: '100', timestamp }], Date.now());
  store.addPlan('100', '100', null, plan({ text: '수정한 본문' }));
  store.addPlan('100', '101', null, plan({ text: coupon }));
  await publish(store, {}, x);
  await publish(store, {}, x);
  assert.deepEqual(calls, [{ text: '본 게시물', parent: null }, { text: coupon, parent: '900' }]);
  assert.equal(store.queued()[0].state, 'manual');
});

test('avoids automatically resending a post after an ambiguous error', async t => {
  const store = withStore(t);
  store.discover([{ id: '100', timestamp: new Date().toISOString() }], Date.now());
  store.addPlan('100', '100', null, plan({ text: '본문' }));
  let calls = 0;
  const x = { async create({ onSend }) { onSend(); calls++; throw new Error('timeout'); } };
  await publish(store, {}, x);
  await publish(store, {}, x);
  assert.equal(calls, 1);
  assert.equal(store.queued()[0].state, 'review');
});

test('uses Meta cursor pagination and sends the official X self-reply shape', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = new URL(url);
    requests.push(request);
    if (request.hostname === 'graph.threads.com') {
      if (request.pathname.endsWith('/me')) return Response.json({ id: '100', username: 'demo' });
      if (request.searchParams.get('after')) return Response.json({ data: [{ id: '102' }] });
      return Response.json({ data: [{ id: '101' }], paging: { next: 'https://graph.threads.com/v1.0/me/threads?after=second', cursors: { after: 'second' } } });
    }
    assert.equal(request.href, 'https://api.x.com/2/tweets');
    assert.deepEqual(JSON.parse(options.body), { text: coupon, reply: { in_reply_to_tweet_id: '900' } });
    return Response.json({ data: { id: '901' } }, { status: 201 });
  });
  const store = withStore(t);
  const threads = new Threads(store, { THREADS_ACCESS_TOKEN: 'fake-token' });
  await threads.profile();
  const now = Date.now();
  assert.deepEqual((await threads.posts(now - 60_000, now)).map(post => post.id), ['101', '102']);
  assert.equal(requests[2].searchParams.get('since'), String(Math.floor((now - 60_000) / 1000)));
  store.set('xToken', { clientId: 'demo', accessToken: 'fake', expiresAt: now + 120_000 });
  const x = new XApi(store, { X_CLIENT_ID: 'demo' });
  assert.equal(await x.create({ text: coupon, media: [], parent: '900', onSend() {} }), '901');
});

test('uploads video by initializing, appending the original bytes and finalizing', async t => {
  const video = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url);
    requested.push(target.pathname);
    switch (target.pathname) {
      case '/source.mp4':
        return new Response(video, { headers: { 'Content-Type': 'video/mp4' } });
      case '/2/media/upload/initialize':
        assert.deepEqual(JSON.parse(options.body), { media_type: 'video/mp4', media_category: 'tweet_video', total_bytes: video.length });
        return Response.json({ data: { id: '123' } });
      case '/2/media/upload/123/append':
        assert.equal(options.body.get('segment_index'), '0');
        assert.deepEqual(new Uint8Array(await options.body.get('media').arrayBuffer()), video);
        return new Response(null, { status: 204 });
      case '/2/media/upload/123/finalize':
        return Response.json({ data: { id: '123' } });
      default:
        throw new Error(`Unexpected path: ${target.pathname}`);
    }
  });
  const store = withStore(t);
  store.set('xToken', { clientId: 'demo', accessToken: 'fake', expiresAt: Date.now() + 120_000 });
  const x = new XApi(store, { X_CLIENT_ID: 'demo' });
  assert.equal(await x.upload({ kind: 'video' }, { media_url: 'https://media.example/source.mp4' }), '123');
  assert.deepEqual(requested, ['/source.mp4', '/2/media/upload/initialize', '/2/media/upload/123/append', '/2/media/upload/123/finalize']);
});
