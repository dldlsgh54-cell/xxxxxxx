import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.mjs';

export const profileIds = ['1', '2', '3', '4', '5'];

export function profilePaths(project, id) {
  if (!profileIds.includes(id)) throw new Error('계정 연결은 1~5번 중에서 선택해 주세요.');
  const directory = id === '1' ? join(project, 'data') : join(project, 'data', 'pairs', id);
  return { id, directory, envFile: id === '1' ? join(project, '.env') : join(directory, '.env') };
}

export function profileSummary(project, id) {
  const { directory } = profilePaths(project, id);
  const defaults = { id, label: `계정 연결 ${id}` };
  if (!existsSync(join(directory, 'sync.sqlite'))) return defaults;
  const store = new Store(directory);
  try {
    const threads = store.get('threadsConnection');
    return {
      id,
      label: store.get('profileLabel') || defaults.label,
      threads: threads?.username || store.get('threadsUsername'),
      x: store.get('xUsername'),
      threadsId: store.get('threadsAccount') || threads?.id,
      xId: store.get('xAccount'),
    };
  } finally {
    store.close();
  }
}

export function assertAccountAvailable(project, selected, platform, user) {
  const service = platform === 'threads' ? 'Threads' : 'X';
  for (const id of profileIds) {
    if (id === selected) continue;
    const other = profileSummary(project, id);
    if (other[`${platform}Id`] === user.id || (other[platform] && other[platform].toLowerCase() === user.username?.toLowerCase())) {
      throw new Error(`이 ${service} 계정은 이미 ‘${other.label}’에 연결되어 있습니다.`);
    }
  }
}
