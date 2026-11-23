import twitterText from 'twitter-text';
import { isCouponUrl } from './content.mjs';

const day = 86_400_000;
const matureDays = 2;
const minBucket = 3;
const fields = 'created_at,conversation_id,public_metrics,entities,attachments,note_post';
const allowedHosts = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'mobile.x.com'];

export function analysisOptions(body) {
  if (typeof body.handles !== 'string' || body.handles.length > 600) throw new Error('X 계정 이름이나 프로필 주소를 입력해 주세요.');
  const handles = new Set();
  for (const value of body.handles.split(/[\s,，]+/u).filter(Boolean)) {
    let handle = value.replace(/^@/, '');
    if (/^https?:\/\//i.test(value) || /^(?:www\.)?(?:x|twitter)\.com\//i.test(value)) {
      const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      const parts = url.pathname.split('/').filter(Boolean);
      if (allowedHosts.includes(url.hostname) && parts.length === 1) [handle] = parts;
    }
    if (!/^[a-z0-9_]{1,15}$/i.test(handle)) throw new Error(`X 계정 입력을 확인해 주세요. ${value.slice(0, 70)}`);
    handles.add(handle.toLowerCase());
  }
  if (!handles.size || handles.size > 5) throw new Error('서로 다른 공개 X 계정을 1~5개 입력해 주세요.');
  if (![14, 30, 60].includes(body.days) || ![25, 50, 100].includes(body.limit)) throw new Error('분석 기간과 계정별 조회량을 선택해 주세요.');
  return { handles: [...handles], days: body.days, limit: body.limit };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function metric(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function links(post) {
  const candidates = [...(post.entities?.urls || []), ...(post.note_post?.entities?.urls || [])];
  return [
    ...candidates.filter(item => !item.media_key).flatMap(item => [item.unwound_url, item.expanded_url, item.url]),
    ...twitterText.extractUrls(post.note_post?.text || post.text || ''),
  ].filter(Boolean);
}

function format(post, media, hasLink) {
  const keys = post.attachments?.media_keys || [];
  const types = keys.map(key => media.get(key));
  if (post.attachments?.poll_ids?.length) return 'poll';
  if (types.includes('video')) return 'video';
  if (types.includes('animated_gif')) return 'gif';
  if (types.includes('photo')) return 'image';
  if (keys.length) return 'media';
  return hasLink ? 'link' : 'text';
}

function externalLink(value) {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.hostname.includes('.') && ![...allowedHosts, 't.co', 'pic.twitter.com', 'pic.x.com'].includes(url.hostname);
  } catch {
    return false;
  }
}

function normalizedScores(rows) {
  const mature = rows.filter(row => row.mature && row.interactions !== null);
  const rated = mature.filter(row => row.rate !== null);
  const method = rated.length >= 5 && rated.length >= mature.length * .7 ? 'rate' : 'interactions';
  const sorted = [...(method === 'rate' ? rated : mature)].sort((a, b) => a[method] - b[method]);
  if (sorted.length < 5) return null;
  for (let first = 0; first < sorted.length;) {
    let next = first + 1;
    while (next < sorted.length && sorted[next][method] === sorted[first][method]) next++;
    const score = 100 * (first + next - 1) / (2 * (sorted.length - 1));
    for (let index = first; index < next; index++) sorted[index].score = score;
    first = next;
  }
  return method;
}

function accountSample({ user, response }, since, now) {
  const media = new Map((response.includes?.media || []).map(item => [item.media_key, item.type]));
  const recent = (response.data || []).filter(post => {
    const time = Date.parse(post.created_at);
    return /^[0-9]{1,19}$/.test(post.id || '') && time >= since && time <= now;
  });
  const limited = Boolean(response.meta?.next_token);
  const sinceObserved = limited && recent.length ? Math.min(...recent.map(post => Date.parse(post.created_at))) : since;
  const linkedReplies = new Set();
  for (const post of recent) {
    const reference = (post.referenced_tweets || post.referenced_posts || []).find(item => item.type === 'replied_to');
    const root = post.conversation_id || reference?.id;
    if (root && root !== post.id && links(post).some(isCouponUrl)) linkedReplies.add(root);
  }
  const rows = recent.filter(post => !post.conversation_id || post.conversation_id === post.id)
    .filter(post => !(post.referenced_tweets || post.referenced_posts || []).some(item => ['replied_to', 'retweeted', 'reposted'].includes(item.type)))
    .map(post => {
      const urls = links(post);
      const time = Date.parse(post.created_at);
      const local = new Date(time + 9 * 3_600_000);
      const publicMetrics = post.public_metrics || {};
      const available = ['like_count', 'reply_count', 'retweet_count', 'quote_count'].map(key => metric(publicMetrics[key]));
      const interactions = available.some(value => value !== null) ? available.reduce((sum, value) => sum + (value || 0), 0) : null;
      const views = metric(publicMetrics.impression_count);
      const bodyLink = urls.some(isCouponUrl);
      const replyLink = linkedReplies.has(post.id);
      return {
        account: user.username, id: post.id, time,
        weekday: (local.getUTCDay() + 6) % 7, hour: 4 * Math.floor(local.getUTCHours() / 4),
        format: format(post, media, urls.some(externalLink)),
        placement: bodyLink && replyLink ? 'both' : bodyLink ? 'body' : replyLink ? 'reply' : 'none',
        characters: [...(post.note_post?.text || post.text || '').replace(/https?:\/\/\S+/gi, '').trim()].length,
        mature: now - time >= matureDays * day, interactions, views,
        rate: interactions !== null && views > 0 ? 100 * interactions / views : null,
        score: null,
      };
    });
  const method = normalizedScores(rows);
  return {
    username: user.username, name: user.name || user.username, followers: metric(user.public_metrics?.followers_count),
    limited, sinceObserved, incompleteThreads: recent.some(post => !post.conversation_id), method, rows,
  };
}

function accountMetrics(account, rows, now) {
  const { rows: allRows, ...metadata } = account;
  const mature = rows.filter(row => row.mature);
  const observedDays = (now - account.sinceObserved) / day;
  return {
    ...metadata, count: rows.length, mature: mature.length, rates: mature.filter(row => row.rate !== null).length,
    perWeek: (!account.limited || observedDays >= 2) ? rows.length * 7 / observedDays : null,
    medianViews: median(mature.map(row => row.views).filter(value => value !== null)),
    medianInteractions: median(mature.map(row => row.interactions).filter(value => value !== null)),
    medianRate: median(mature.map(row => row.rate).filter(value => value !== null)),
  };
}

function group(rows) {
  const byAccount = new Map();
  for (const row of rows) {
    if (row.score === null) continue;
    const values = byAccount.get(row.account) || [];
    values.push(row.score);
    byAccount.set(row.account, values);
  }
  const sample = [...byAccount.values()].flat().length;
  return {
    count: rows.length, sample, accounts: byAccount.size,
    score: sample >= minBucket ? median([...byAccount.values()].map(median)) : null,
  };
}

function reportScope(accounts, now, couponOnly = false) {
  const entries = accounts.map(account => {
    const rows = couponOnly ? account.rows.filter(row => row.placement !== 'none') : account.rows;
    return { rows, metrics: accountMetrics(account, rows, now) };
  });
  const rows = entries.flatMap(entry => entry.rows);
  const metrics = entries.map(entry => entry.metrics);
  const heat = Array.from({ length: 7 }, (_, weekday) => Array.from({ length: 6 }, (_, slot) => ({
    weekday, hour: slot * 4, ...group(rows.filter(row => row.weekday === weekday && row.hour === slot * 4)),
  }))).flat();
  const rank = (left, right) => right.score - left.score || right.accounts - left.accounts || right.sample - left.sample;
  const windows = heat.filter(cell => cell.score !== null && cell.score > 50).sort(rank).slice(0, 3);
  const categories = (key, values) => values.map(id => ({ id, ...group(rows.filter(row => row[key] === id)) }));
  const bestPosts = rows.filter(row => row.score > 50).sort((a, b) => b.score - a.score || b.interactions - a.interactions).slice(0, 8);
  return {
    heat, windows, bestPosts, accounts: metrics,
    formats: categories('format', ['text', 'image', 'video', 'gif', 'link', 'poll', 'media']).filter(item => item.count),
    placements: categories('placement', ['body', 'reply', 'both', 'none']),
    total: rows.length, comparable: rows.filter(row => row.score !== null).length,
    typicalPerWeek: median(metrics.map(account => account.perWeek).filter(value => value !== null)),
    medianLength: median(rows.map(row => row.characters)),
  };
}

export function summarizeAnalysis(samples, options, errors, now) {
  const since = now - options.days * day;
  const accounts = samples.map(sample => accountSample(sample, since, now));
  return {
    options, since, at: now, errors, minBucket, matureDays,
    ...reportScope(accounts, now), coupang: reportScope(accounts, now, true),
  };
}

export async function fetchAnalysis(read, options, now = Date.now()) {
  const users = await read(`users/by?${new URLSearchParams({ usernames: options.handles.join(','), 'user.fields': 'protected,public_metrics' })}`);
  const byName = new Map((users?.data || []).map(user => [user.username.toLowerCase(), user]));
  const samples = [];
  const errors = [];
  for (const username of options.handles) {
    const user = byName.get(username);
    if (!user || user.protected || !/^[0-9]{1,19}$/.test(user.id || '')) {
      errors.push({ username, reason: user?.protected ? '비공개 계정입니다.' : '공개 계정을 찾을 수 없습니다.' });
      continue;
    }
    const query = new URLSearchParams({
      start_time: new Date(now - options.days * day).toISOString(), max_results: String(options.limit), exclude: 'retweets',
      'post.fields': fields, expansions: 'attachments.media_keys', 'media.fields': 'type',
    });
    const path = `users/${user.id}/tweets`;
    try {
      let response = await read(`${path}?${query}`).catch(error => {
        if (error.status === 400) return null;
        throw error;
      });
      if (response === null || (response?.data?.length && !response.data.some(post => post.created_at))) {
        query.delete('post.fields');
        query.set('tweet.fields', fields);
        response = await read(`${path}?${query}`);
      }
      if (!response || response.data?.some(post => !post.created_at) || (!response.data?.length && response.errors?.length)) {
        throw new Error('게시 시각이나 공개 지표를 조회하지 못했습니다.');
      }
      samples.push({ user, response });
    } catch (error) {
      if ([401, 402, 429].includes(error.status)) throw error;
      errors.push({ username, reason: error.message });
    }
  }
  return summarizeAnalysis(samples, options, errors, now);
}
