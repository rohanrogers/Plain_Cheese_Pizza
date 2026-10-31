import session from 'express-session';
import { db } from './db.js';

export class DatabaseSessionStore extends session.Store {
  constructor() {
    super();
  }

  get(sid, callback) {
    try {
      const sqlite = db.getSqliteInstance();
      const row = sqlite.prepare('SELECT sess, expire FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);

      if (new Date(row.expire) <= new Date()) {
        this.destroy(sid, () => {});
        return callback(null, null);
      }

      const sess = JSON.parse(row.sess);
      callback(null, sess);
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      const sqlite = db.getSqliteInstance();
      const maxAge = sess.cookie?.maxAge || 1000 * 60 * 60 * 24;
      const expire = new Date(Date.now() + maxAge).toISOString();
      const sessStr = JSON.stringify(sess);
      const userId = sess.user?.id || null;

      sqlite.prepare(`
        INSERT INTO sessions (sid, sess, user_id, expire)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, user_id = excluded.user_id, expire = excluded.expire
      `).run(sid, sessStr, userId, expire);

      callback && callback(null);
    } catch (err) {
      callback && callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      const sqlite = db.getSqliteInstance();
      sqlite.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback && callback(null);
    } catch (err) {
      callback && callback(err);
    }
  }

  touch(sid, sess, callback) {
    try {
      const sqlite = db.getSqliteInstance();
      const maxAge = sess.cookie?.maxAge || 1000 * 60 * 60 * 24;
      const expire = new Date(Date.now() + maxAge).toISOString();
      sqlite.prepare('UPDATE sessions SET expire = ? WHERE sid = ?').run(expire, sid);
      callback && callback(null);
    } catch (err) {
      callback && callback(err);
    }
  }
}

