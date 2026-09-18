import Database from 'better-sqlite3';
import Keyv from 'keyv';

const db = new Database('database.sqlite');
const cache = new Keyv();

// --- OPTIMIZATIONS ---
// 1. WAL Mode: Concurrency boost (read while write)
db.pragma('journal_mode = WAL');

// 2. Synchronous Normal: High performance with safe writes
db.pragma('synchronous = NORMAL');

// 3. Cache Size: 64MB memory cache
db.pragma('cache_size = 64000');

// --- CACHE KEYS ---
const CACHE_KEYS = {
  FEATURED_APPS: 'featured_apps',
  PUBLIC_BOOKMARKS: 'public_bookmarks'
};

// --- Cache Invalidation Helper ---
const invalidateCache = async (keys) => {
  try {
    if (Array.isArray(keys)) {
      for (const k of keys) await cache.delete(k);
    } else {
      await cache.delete(keys);
    }
  } catch (err) {
    console.error('[Cache] Error invalidating cache:', err.message);
  }
};

// Initialize Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'user',
    is_approved INTEGER DEFAULT 0,
    pin TEXT
  );

  CREATE TABLE IF NOT EXISTS apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    slug TEXT UNIQUE,
    original_name TEXT,
    title TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_featured INTEGER DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    url TEXT NOT NULL,
    title TEXT,
    icon TEXT,
    is_public INTEGER DEFAULT 1,
    is_protected INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_approve', '0');
`);

// Auto-migration helper for existing legacy databases
const ensureColumn = (table, column, definition) => {
  try {
    const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all();
    const exists = tableInfo.some((col) => col.name === column);
    if (!exists) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`[DB Migration] Added missing column '${column}' to '${table}' table.`);
    }
  } catch (err) {
    console.error(`[DB Migration] Error checking column '${column}' in '${table}':`, err.message);
  }
};

ensureColumn('users', 'pin', 'TEXT');
ensureColumn('users', 'role', "TEXT DEFAULT 'user'");
ensureColumn('users', 'is_approved', 'INTEGER DEFAULT 0');
ensureColumn('apps', 'is_featured', 'INTEGER DEFAULT 0');
ensureColumn('bookmarks', 'is_public', 'INTEGER DEFAULT 1');
ensureColumn('bookmarks', 'is_protected', 'INTEGER DEFAULT 0');

// Create Performance Indexes safely after columns are guaranteed to exist
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_apps_user ON apps(user_id);
  CREATE INDEX IF NOT EXISTS idx_apps_featured ON apps(is_featured);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_public ON bookmarks(is_public, is_protected);
`);

// --- User Functions ---
export const createUser = (username, password, isApproved = 0, role = 'user') => {
  const stmt = db.prepare('INSERT INTO users (username, password, is_approved, role) VALUES (?, ?, ?, ?)');
  return stmt.run(username, password, isApproved, role);
};

export const findUserByUsername = (username) => {
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  return stmt.get(username);
};

export const findUserById = (id) => {
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  return stmt.get(id);
};

export const getAllUsers = () => {
  const stmt = db.prepare('SELECT id, username, role, is_approved FROM users ORDER BY id DESC');
  return stmt.all();
};

export const updateUserStatus = (userId, isApproved) => {
  const stmt = db.prepare('UPDATE users SET is_approved = ? WHERE id = ?');
  return stmt.run(isApproved, userId);
};

// --- App Functions ---
export const createApp = (userId, slug, originalName, title) => {
  const stmt = db.prepare('INSERT INTO apps (user_id, slug, original_name, title) VALUES (?, ?, ?, ?)');
  const res = stmt.run(userId, slug, originalName, title);
  invalidateCache([CACHE_KEYS.FEATURED_APPS]);
  return res;
};

export const getAppsByUser = (userId) => {
  const stmt = db.prepare('SELECT * FROM apps WHERE user_id = ? ORDER BY created_at DESC');
  return stmt.all(userId);
};

export const getAppBySlug = (slug) => {
  const stmt = db.prepare('SELECT * FROM apps WHERE slug = ?');
  return stmt.get(slug);
};

export const updateApp = (slug, title, originalName) => {
  if (originalName) {
    const stmt = db.prepare('UPDATE apps SET title = ?, original_name = ?, created_at = CURRENT_TIMESTAMP WHERE slug = ?');
    stmt.run(title, originalName, slug);
  } else {
    const stmt = db.prepare('UPDATE apps SET title = ?, created_at = CURRENT_TIMESTAMP WHERE slug = ?');
    stmt.run(title, slug);
  }
  invalidateCache([CACHE_KEYS.FEATURED_APPS]);
};

export const deleteApp = (slug, userId) => {
  const stmt = db.prepare('DELETE FROM apps WHERE slug = ? AND user_id = ?');
  const res = stmt.run(slug, userId);
  invalidateCache([CACHE_KEYS.FEATURED_APPS]);
  return res;
};

export const getAllApps = () => {
  const stmt = db.prepare(`
    SELECT apps.*, users.username as author 
    FROM apps 
    JOIN users ON apps.user_id = users.id 
    ORDER BY apps.created_at DESC
  `);
  return stmt.all();
};

export const getFeaturedApps = async () => {
  const cached = await cache.get(CACHE_KEYS.FEATURED_APPS);
  if (cached) return cached;

  const stmt = db.prepare(`
    SELECT apps.*, users.username as author 
    FROM apps 
    JOIN users ON apps.user_id = users.id 
    WHERE apps.is_featured = 1 
    ORDER BY apps.created_at DESC
  `);
  const data = stmt.all();
  await cache.set(CACHE_KEYS.FEATURED_APPS, data, 1000 * 60 * 60 * 24);
  return data;
};

export const updateAppFeatured = (appId, isFeatured) => {
  const stmt = db.prepare('UPDATE apps SET is_featured = ? WHERE id = ?');
  const res = stmt.run(isFeatured, appId);
  invalidateCache([CACHE_KEYS.FEATURED_APPS]);
  return res;
};

// --- Settings Functions ---
export const getSetting = (key) => {
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const result = stmt.get(key);
  return result ? result.value : null;
};

export const setSetting = (key, value) => {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  return stmt.run(key, value);
};

// --- Bookmark Functions ---
export const createBookmark = (userId, url, title, icon, isPublic, isProtected = 0) => {
  const stmt = db.prepare('INSERT INTO bookmarks (user_id, url, title, icon, is_public, is_protected) VALUES (?, ?, ?, ?, ?, ?)');
  const res = stmt.run(userId, url, title, icon, isPublic, isProtected);
  invalidateCache([CACHE_KEYS.PUBLIC_BOOKMARKS]);
  return res;
};

export const getBookmarksByUser = (userId) => {
  const stmt = db.prepare('SELECT * FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC');
  return stmt.all(userId);
};

export const getPublicBookmarks = async () => {
  const cached = await cache.get(CACHE_KEYS.PUBLIC_BOOKMARKS);
  if (cached) return cached;

  const data = db.prepare(`
    SELECT bookmarks.*, users.username as author 
    FROM bookmarks JOIN users ON bookmarks.user_id = users.id 
    WHERE bookmarks.is_public = 1 AND bookmarks.is_protected = 0
    ORDER BY bookmarks.created_at DESC
  `).all();

  await cache.set(CACHE_KEYS.PUBLIC_BOOKMARKS, data, 1000 * 60 * 60 * 24);
  return data;
};

export const deleteBookmark = (id, userId) => {
  const stmt = db.prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?');
  const res = stmt.run(id, userId);
  invalidateCache([CACHE_KEYS.PUBLIC_BOOKMARKS]);
  return res;
};

export const setUserPin = (userId, hashedPin) => {
  const stmt = db.prepare('UPDATE users SET pin = ? WHERE id = ?');
  return stmt.run(hashedPin, userId);
};

export const getProtectedBookmarks = (userId) => {
  return db.prepare(`
    SELECT bookmarks.*, users.username as author 
    FROM bookmarks JOIN users ON bookmarks.user_id = users.id 
    WHERE bookmarks.is_protected = 1 AND bookmarks.user_id = ?
    ORDER BY bookmarks.created_at DESC
  `).all(userId);
};