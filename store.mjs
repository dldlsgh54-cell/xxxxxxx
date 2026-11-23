import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = directory;
    this.db = new DatabaseSync(join(directory, 'sync.sqlite'));
    this.db.exec(`
      PRAGMA busy_timeout = 3000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS roots (
        id TEXT PRIMARY KEY, published INTEGER NOT NULL, permalink TEXT,
        plan_next INTEGER NOT NULL DEFAULT 0, planned INTEGER NOT NULL DEFAULT 0,
        plan_error TEXT, reply_next INTEGER NOT NULL DEFAULT 0, reply_error TEXT,
        reply_checked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS queue (
        key TEXT PRIMARY KEY, root TEXT NOT NULL, item TEXT NOT NULL, part INTEGER NOT NULL,
        parent TEXT, payload TEXT NOT NULL, source TEXT, x_id TEXT UNIQUE,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0, error TEXT
      );
      CREATE INDEX IF NOT EXISTS queue_pending ON queue (state, retry_at);
      CREATE INDEX IF NOT EXISTS roots_reply ON roots (reply_next);
    `);
    if (!this.hasReplyCheckedColumn()) {
      this.transaction(() => {
        if (!this.hasReplyCheckedColumn()) this.db.exec('ALTER TABLE roots ADD COLUMN reply_checked INTEGER NOT NULL DEFAULT 0');
      }, 'IMMEDIATE');
    }
  }

  close() { this.db.close(); }

  hasReplyCheckedColumn() {
    return this.db.prepare("SELECT 1 FROM pragma_table_info('roots') WHERE name = 'reply_checked'").get();
  }

  lock() {
    const lock = new DatabaseSync(join(this.directory, 'worker-lock.sqlite'));
    try {
      lock.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      lock.close();
      if (/locked|busy/i.test(error.message)) throw new Error('다른 작업이 실행 중입니다. 잠시 후 다시 시도합니다.');
      throw error;
    }
    return () => lock.close();
  }

  get(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : undefined;
  }

  set(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(key, JSON.stringify(value));
  }

  pin(key, id) {
    const current = this.get(key);
    if (current && current !== id) throw new Error('이 데이터 폴더는 다른 계정에 연결되어 있습니다.');
    if (!current) this.set(key, id);
  }

  transaction(action, mode = 'DEFERRED') {
    this.db.exec(`BEGIN ${mode}`);
    try {
      action();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  discover(posts, through) {
    const add = this.db.prepare('INSERT OR IGNORE INTO roots(id,published,permalink) VALUES (?,?,?)');
    const ordered = posts.map(post => ({ ...post, published: Date.parse(post.timestamp) }))
      .sort((first, second) => first.published - second.published || first.id.localeCompare(second.id));
    this.transaction(() => {
      for (const post of ordered) add.run(post.id, post.published, post.permalink || null);
      this.set('discoveredThrough', through);
    });
  }

  unplanned(now, limit = 50) {
    return this.db.prepare('SELECT * FROM roots WHERE planned = 0 AND plan_next <= ? ORDER BY rowid LIMIT ?').all(now, limit);
  }

  addPlan(root, item, source, parts) {
    if (!parts.length) throw new Error('옮길 수 있는 본문이나 첨부 파일을 찾을 수 없습니다.');
    const insert = this.db.prepare(`INSERT OR IGNORE INTO queue(key,root,item,part,parent,payload,source) VALUES (?,?,?,?,?,?,?)`);
    this.transaction(() => {
      for (const [index, part] of parts.entries()) {
        const parent = index ? `${item}:${index - 1}` : item === root ? null : `${root}:0`;
        insert.run(`${item}:${index}`, root, item, index, parent, JSON.stringify(part), source || null);
      }
      if (item === root) this.db.prepare('UPDATE roots SET planned = 1, plan_error = NULL WHERE id = ?').run(root);
    });
  }

  hasItem(item) {
    return Boolean(this.db.prepare('SELECT 1 FROM queue WHERE key = ?').get(`${item}:0`));
  }

  planFailed(root, error, next) {
    this.db.prepare('UPDATE roots SET plan_error = ?, plan_next = ? WHERE id = ?').run(error, next, root);
  }

  forReplies(now, earliest, interval, limit = 50) {
    return this.db.prepare(`
      SELECT * FROM roots WHERE planned = 1 AND (
        (reply_error IS NULL AND reply_checked <= ? AND (reply_checked = 0 OR published >= ?))
        OR (reply_error IS NOT NULL AND reply_next <= ?)
      ) ORDER BY reply_checked, published LIMIT ?
    `).all(now - interval, earliest, now, limit);
  }

  replyChecked(root, checked) {
    this.db.prepare('UPDATE roots SET reply_checked = ?, reply_next = 0, reply_error = NULL WHERE id = ?').run(checked, root);
  }

  replyFailed(root, next, error) {
    this.db.prepare('UPDATE roots SET reply_next = ?, reply_error = ? WHERE id = ?').run(next, error, root);
  }

  ready(now, root = null) {
    return this.db.prepare(`
      SELECT q.*, p.x_id AS parent_x_id FROM queue q
      LEFT JOIN queue p ON p.key = q.parent
      WHERE q.state = 'pending' AND q.retry_at <= ? AND (q.parent IS NULL OR p.x_id IS NOT NULL)
        AND (? IS NULL OR q.root = ?)
      ORDER BY q.rowid LIMIT 1
    `).get(now, root, root);
  }

  sending(key) {
    this.db.prepare("UPDATE queue SET state = 'review', attempts = attempts + 1, error = '전송 결과를 확인해야 합니다.' WHERE key = ?").run(key);
  }

  posted(key, xId) {
    this.db.prepare("UPDATE queue SET state = 'posted', x_id = ?, error = NULL WHERE key = ?").run(xId, key);
  }

  failed(key, state, error, retryAt = 0, attemptedSend = false) {
    this.db.prepare('UPDATE queue SET state = ?, error = ?, retry_at = ?, attempts = attempts + ? WHERE key = ?')
      .run(state, error, retryAt, attemptedSend ? 0 : 1, key);
  }

  retry(key) {
    return this.db.prepare("UPDATE queue SET state = 'pending', error = NULL, retry_at = 0 WHERE key = ? AND state != 'posted'").run(key).changes;
  }

  queued() {
    return this.db.prepare(`
      SELECT q.key, q.state, q.retry_at, q.error, q.payload, q.source, p.x_id AS parent_x_id, q.parent
      FROM queue q LEFT JOIN queue p ON p.key = q.parent WHERE q.state != 'posted'
      ORDER BY q.state = 'pending', q.rowid LIMIT 50
    `).all();
  }

  review(key) {
    return this.db.prepare(`SELECT q.state, q.parent, p.x_id AS parent_x_id FROM queue q LEFT JOIN queue p ON p.key = q.parent WHERE q.key = ?`).get(key);
  }

  counts() {
    return this.db.prepare('SELECT state, COUNT(*) AS count FROM queue GROUP BY state').all();
  }

  activity() {
    return this.db.prepare(`
      SELECT q.key, q.state, q.error, q.payload, q.source, q.x_id, q.item != q.root AS reply, p.x_id AS parent_x_id
      FROM queue q LEFT JOIN queue p ON p.key = q.parent
      ORDER BY CASE q.state WHEN 'manual' THEN 0 WHEN 'review' THEN 0 WHEN 'blocked' THEN 0 ELSE 1 END,
        CASE WHEN q.state = 'pending' THEN q.rowid ELSE -q.rowid END LIMIT 60
    `).all();
  }

  sourceErrors() {
    return this.db.prepare('SELECT id, plan_error, reply_error FROM roots WHERE plan_error IS NOT NULL OR reply_error IS NOT NULL LIMIT 50').all();
  }
}
