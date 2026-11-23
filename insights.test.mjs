import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analysisOptions, fetchAnalysis, summarizeAnalysis } from './insights.mjs';

const now = Date.parse('2026-11-23T01:00:00Z');
const post = (id, time, likes, extra = {}) => ({
  id, conversation_id: id, created_at: `2026-11-${time}:00Z`, text: '상품 소개',
  public_metrics: { like_count: likes, impression_count: 1000 }, ...extra,
});

function fixture() {
  return {
    user: { id: '1', username: 'shopping', public_metrics: { followers_count: 500 } },
    response: {
      includes: { media: [{ media_key: '3_1', type: 'photo' }] },
      data: [
        post('100', '02T00:00', 20),
        post('200', '09T00:00', 30, { attachments: { media_keys: ['3_1'] } }),
        post('300', '16T00:00', 40, { entities: { urls: [{ unwound_url: 'https://link.coupang.com/a/sample' }] } }),
        post('400', '17T05:00', 1, { entities: { urls: [{ expanded_url: 'https://coupang.com.fake.test/a' }] } }),
        post('500', '18T07:00', 3),
        post('600', '22T22:00', 900),
        post('700', '09T00:02', 500, { conversation_id: '200', entities: { urls: [{ expanded_url: 'https://coupa.ng/deal' }] } }),
        post('800', '09T00:03', 500, { conversation_id: '999', text: 'https://coupa.ng/unrelated' }),
      ],
    },
  };
}

test('accepts pasted handles and profile links, deduplicates, and rejects other destinations', () => {
  assert.deepEqual(analysisOptions({ handles: '@Shopping, https://x.com/SHOPPING\nX.COM/Deals', days: 30, limit: 50 }), {
    handles: ['shopping', 'deals'], days: 30, limit: 50,
  });
  assert.throws(() => analysisOptions({ handles: 'https://evil.test/shopping', days: 30, limit: 50 }), /확인/);
  assert.throws(() => analysisOptions({ handles: 'https://x.com/shopping/status/200', days: 30, limit: 50 }), /확인/);
});

test('groups mature public reactions in Korean time and tracks coupon links on the correct reply conversation', () => {
  const report = summarizeAnalysis([fixture()], { days: 30 }, [], now);
  assert.equal(report.total, 6);
  assert.equal(report.comparable, 5);
  assert.equal(report.accounts[0].method, 'rate');
  assert.equal(report.windows[0].hour, 8);
  assert.equal(report.windows[0].weekday, 0);
  assert.equal(report.windows[0].sample, 3);
  assert.equal(report.windows[0].score, 75);
  assert.equal(report.bestPosts[0].id, '300');
  assert.ok(report.bestPosts.every(item => item.score > 50));
  assert.equal(report.formats.find(item => item.id === 'image').count, 1);
  assert.deepEqual(report.placements.map(entry => entry.count), [1, 1, 0, 4]);
  assert.equal(report.coupang.total, 2);
  assert.equal(report.coupang.windows.length, 0);
});

test('uses documented timeline fields and skips private accounts before reading posts', async () => {
  const requests = [];
  const options = { handles: ['shopping', 'private', 'missing'], days: 30, limit: 25 };
  const report = await fetchAnalysis(async path => {
    const url = new URL(`https://api.x.com/2/${path}`);
    requests.push(url);
    if (url.pathname === '/2/users/by') return { data: [fixture().user, { id: '2', username: 'private', protected: true }] };
    assert.equal(url.pathname, '/2/users/1/tweets');
    assert.equal(url.searchParams.get('exclude'), 'retweets');
    assert.equal(url.searchParams.get('max_results'), '25');
    if (url.searchParams.has('post.fields')) throw Object.assign(new Error('unsupported field name'), { status: 400 });
    assert.match(url.searchParams.get('tweet.fields'), /conversation_id/);
    return fixture().response;
  }, options, now);
  assert.equal(requests.length, 3);
  assert.equal(report.accounts.length, 1);
  assert.deepEqual(report.errors.map(error => error.username), ['private', 'missing']);
});
