import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const options = {
  interval: ['POLL_SECONDS', 60, 15, 3600, '새 글 확인 주기', '초'],
  replyInterval: ['REPLY_POLL_SECONDS', 300, 15, 3600, '쿠팡 댓글 확인 주기', '초'],
  publishInterval: ['X_PUBLISH_SECONDS', 0, 0, 3600, 'X 게시 주기', '초'],
  lookback: ['REPLY_LOOKBACK_DAYS', 7, 1, 365, '댓글 확인 기간', '일'],
};

export function timingValues(env) {
  return Object.fromEntries(Object.entries(options).map(([field, [key, fallback]]) => [field, Number(env[key] || fallback)]));
}

export function timingEnv(values) {
  return Object.fromEntries(Object.entries(options).map(([field, [key, , min, max, label, unit]]) => {
    const value = values[field];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${label}는 ${min}~${max}${unit} 사이의 정수로 입력해 주세요.`);
    }
    return [key, value];
  }));
}

export function loadTiming(file, environment) {
  let config = {};
  try {
    config = parseEnv(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const values = timingValues({ ...environment, ...config });
  timingEnv(values);
  return values;
}

export function due(last, seconds, now) {
  return !last || last + seconds * 1000 <= now;
}
