import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as db from './db.js';
import { requireAuth, requireAdmin, requireApproval, generateToken } from './middleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');
const PORT_FILE = path.join(PROJECT_ROOT, 'port.txt');
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-this-in-prod';

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(PROJECT_ROOT, 'views'));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(PROJECT_ROOT, 'public')));

// Cache static assets (CSS, Images) for 1 day
app.use((req, res, next) => {
  if (req.url.match(/\.(css|js|png|jpg|ico|svg|woff2)$/)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
  next();
});

const upload = multer({ dest: path.join(PROJECT_ROOT, 'uploads') });

// --- Helper Functions ---
const createSlug = (str) => {
  if (!str) return '';
  return str
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
};

// Simple scraper using native fetch to get <title> and favicon
const fetchUrlMetadata = async (targetUrl) => {
  try {
    let normalizedUrl = targetUrl.trim();
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      normalizedUrl = 'https://' + normalizedUrl;
    }

    const response = await fetch(normalizedUrl, {
      signal: AbortSignal.timeout(5000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AppsLoaderMetadataBot/1.0)'
      }
    });

    const html = await response.text();

    // Extract Title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    let title = titleMatch ? titleMatch[1].trim() : new URL(normalizedUrl).hostname;

    // Extract Favicon
    let icon = '';
    const iconMatch = html.match(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["'](.*?)["']/i);

    if (iconMatch) {
      icon = iconMatch[1];
      if (!icon.startsWith('http')) {
        const origin = new URL(normalizedUrl).origin;
        icon = new URL(icon, origin).href;
      }
    } else {
      const origin = new URL(normalizedUrl).origin;
      icon = origin + '/favicon.ico';
    }

    return { title, icon, url: normalizedUrl };
  } catch (err) {
    console.error('[Metadata] Error fetching URL metadata:', err.message);
    const fallbackOrigin = targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl;
    return { title: targetUrl, icon: '', url: fallbackOrigin };
  }
};

const moveAndRenameFile = (tempPath, slug) => {
  const appDir = path.join(PROJECT_ROOT, 'apps', slug);
  if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
  fs.renameSync(tempPath, path.join(appDir, 'index.html'));
};

const saveStringAsFile = (content, slug) => {
  const appDir = path.join(PROJECT_ROOT, 'apps', slug);
  if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'index.html'), content);
};

const parseFileContent = (fullContent) => {
  let html = fullContent;
  let css = '';
  let js = '';

  // 1. Extract and Remove Inline CSS (<style>...</style>)
  html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (match, content) => {
    css += content.trim() + '\n\n';
    return '';
  });

  // 2. Extract and Remove Inline JS (<script>...</script> without src)
  html = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (match, attributes, content) => {
    if (attributes && attributes.includes('src=')) {
      return match;
    }
    js += content.trim() + '\n\n';
    return '';
  });

  // 3. Extract BODY content
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    html = bodyMatch[1];
  } else {
    html = html
      .replace(/<!DOCTYPE html>/i, '')
      .replace(/<html[^>]*>/i, '')
      .replace(/<\/html>/i, '')
      .replace(/<head[^>]*>([\s\S]*?)<\/head>/i, '')
      .trim();
  }

  return {
    html: html.trim(),
    css: css.trim(),
    js: js.trim()
  };
};

// --- PUBLIC ROUTES ---
app.get('/', async (req, res) => {
  try {
    const featuredApps = (await db.getFeaturedApps()) || [];
    const publicBookmarks = (await db.getPublicBookmarks()) || [];

    res.render('home', {
      featuredApps,
      publicBookmarks,
      userToken: req.cookies.token
    });
  } catch (err) {
    console.error('[Route /] Failed to render home:', err);
    res.render('home', { featuredApps: [], publicBookmarks: [], userToken: req.cookies.token });
  }
});

app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.findUserByUsername(username);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    console.log('[Auth] Login failed for user:', username);
    return res.render('login', { error: 'Invalid username or password' });
  }

  const token = generateToken(user);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });
  console.log('[Auth] User logged in successfully:', username);
  res.redirect('/dashboard');
});

app.get('/register', (req, res) => res.render('register', { error: null }));

app.post('/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('register', { error: 'Username and password required' });
  }

  try {
    const hashedPassword = bcrypt.hashSync(password, 10);
    const autoApproveStr = db.getSetting('auto_approve');
    const isApproved = autoApproveStr === '1' ? 1 : 0;
    db.createUser(username.trim(), hashedPassword, isApproved);
    console.log('[Auth] New user registered:', username, 'Approved:', isApproved);
    res.redirect('/login');
  } catch (err) {
    console.error('[Auth] Registration error:', err.message);
    res.render('register', { error: 'Username already taken or invalid' });
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/');
});

// --- DASHBOARD ---
app.get('/dashboard', requireAuth, (req, res) => {
  const apps = db.getAppsByUser(req.user.id);
  const bookmarks = db.getBookmarksByUser(req.user.id);
  const error = req.query.error || null;
  res.render('dashboard', { user: req.user, apps, bookmarks, error });
});

// --- FIDDLE ---
app.get('/fiddle', requireAuth, (req, res) => {
  res.render('fiddle', { user: req.user, prefill: null });
});

app.post('/fiddle/save', requireAuth, requireApproval, (req, res) => {
  const { html, css, js, slug, title } = req.body;

  let safeSlug = createSlug(slug);
  if (!safeSlug) safeSlug = 'fiddle-' + Math.random().toString(36).substring(2, 8);
  const appTitle = title && title.trim().length > 0 ? title.trim() : 'Untitled Fiddle';

  try {
    const existing = db.getAppBySlug(safeSlug);

    if (existing && existing.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Slug exists and belongs to another user.' });
    }

    const finalHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${appTitle}</title>
<style>${css || ''}</style>
</head>
<body>
${html || ''}
<script>${js || ''}<\/script>
</body>
</html>`;

    saveStringAsFile(finalHtml, safeSlug);

    if (existing) {
      db.updateApp(safeSlug, appTitle, 'index.html');
      console.log(`[Fiddle] Updated app '${safeSlug}' by user ${req.user.username}`);
    } else {
      db.createApp(req.user.id, safeSlug, 'Fiddle Project', appTitle);
      console.log(`[Fiddle] Created app '${safeSlug}' by user ${req.user.username}`);
    }

    res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    console.error('[Fiddle] Save error:', err);
    res.status(500).json({ error: 'Server Error saving fiddle' });
  }
});

// Load Editor with existing app data
app.get('/fiddle/:slug', requireAuth, (req, res) => {
  const { slug } = req.params;
  const appData = db.getAppBySlug(slug);

  if (!appData) return res.status(404).render('error', { message: 'App not found' });
  if (appData.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).render('error', { message: 'Unauthorized' });
  }

  const appDir = path.join(PROJECT_ROOT, 'apps', slug);
  const filePath = path.join(appDir, 'index.html');

  if (!fs.existsSync(filePath)) return res.status(404).render('error', { message: 'Application source file missing' });

  const fullContent = fs.readFileSync(filePath, 'utf-8');
  const { html, css, js } = parseFileContent(fullContent);

  res.render('fiddle', {
    user: req.user,
    prefill: {
      slug: appData.slug,
      title: appData.title,
      html,
      css,
      js
    }
  });
});

// --- ADMIN ---
app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  const users = db.getAllUsers();
  const apps = db.getAllApps();
  const autoApprove = db.getSetting('auto_approve') === '1';
  res.render('admin', { user: req.user, users, apps, autoApprove });
});

app.post('/admin/approve', requireAuth, requireAdmin, (req, res) => {
  const { userId, action } = req.body;
  db.updateUserStatus(userId, action === 'approve' ? 1 : 0);
  console.log(`[Admin] User ID ${userId} ${action === 'approve' ? 'approved' : 'revoked'}`);
  res.redirect('/admin');
});

app.post('/admin/settings', requireAuth, requireAdmin, (req, res) => {
  db.setSetting('auto_approve', req.body.autoApprove ? '1' : '0');
  console.log('[Admin] auto_approve updated to:', req.body.autoApprove ? '1' : '0');
  res.redirect('/admin');
});

app.post('/admin/feature', requireAuth, requireAdmin, (req, res) => {
  db.updateAppFeatured(req.body.appId, req.body.isFeatured ? 1 : 0);
  console.log(`[Admin] App ID ${req.body.appId} featured status:`, req.body.isFeatured ? 1 : 0);
  res.redirect('/admin');
});

// --- UPLOAD ---
app.post('/upload', requireAuth, requireApproval, upload.single('htmlFile'), (req, res) => {
  const { slug, title } = req.body;
  const file = req.file;

  if (!file) return res.redirect('/dashboard?error=No file uploaded');

  let safeSlug = createSlug(slug);
  if (!safeSlug) safeSlug = createSlug(file.originalname.split('.')[0]) || ('app-' + Date.now());
  const appTitle = title && title.trim().length > 0 ? title.trim() : safeSlug;

  try {
    const existing = db.getAppBySlug(safeSlug);
    if (existing) {
      fs.unlinkSync(file.path);
      return res.redirect('/dashboard?error=Slug already in use. Choose another.');
    }
    moveAndRenameFile(file.path, safeSlug);
    db.createApp(req.user.id, safeSlug, file.originalname, appTitle);
    console.log(`[Upload] New app deployed: ${safeSlug} by user ${req.user.username}`);
    res.redirect('/dashboard');
  } catch (e) {
    console.error('[Upload] Error uploading app:', e);
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.redirect('/dashboard?error=Failed to upload application');
  }
});

// --- UPDATE ---
app.post('/update', requireAuth, requireApproval, upload.single('htmlFile'), (req, res) => {
  const { slug, title } = req.body;
  const file = req.file;

  if (!slug || !title) return res.redirect('/dashboard');

  const appData = db.getAppBySlug(slug);
  if (!appData || (appData.user_id !== req.user.id && req.user.role !== 'admin')) {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(403).render('error', { message: 'Unauthorized' });
  }

  try {
    if (file) {
      moveAndRenameFile(file.path, slug);
      db.updateApp(slug, title.trim(), file.originalname);
    } else {
      db.updateApp(slug, title.trim(), null);
    }
    console.log(`[Update] App '${slug}' updated successfully`);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('[Update] Error updating app:', err);
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.redirect('/dashboard?error=Failed to update project');
  }
});

// --- DELETE APP ---
app.post('/apps/delete', requireAuth, requireApproval, (req, res) => {
  const { slug } = req.body;
  if (!slug) return res.redirect('/dashboard');

  try {
    const appData = db.getAppBySlug(slug);
    if (!appData) {
      return res.redirect('/dashboard?error=App not found');
    }
    if (appData.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).render('error', { message: 'Unauthorized to delete this app' });
    }

    db.deleteApp(slug, appData.user_id);

    const appDir = path.join(PROJECT_ROOT, 'apps', slug);
    if (fs.existsSync(appDir)) {
      fs.rmSync(appDir, { recursive: true, force: true });
    }

    console.log(`[App] Deleted app '${slug}' for user ID ${appData.user_id}`);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('[App] Error deleting app:', err);
    res.redirect('/dashboard?error=Failed to delete app');
  }
});

// --- STATIC SITES ---
app.use('/sites', express.static(path.join(PROJECT_ROOT, 'apps')));
app.use('/sites/:slug', (req, res, next) => {
  if (!req.path.endsWith('/')) return res.redirect(req.originalUrl + '/');
  next();
});

// --- BOOKMARK API & ROUTES ---
app.post('/api/preview-url', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const data = await fetchUrlMetadata(url);
  res.json(data);
});

app.post('/bookmarks/create', requireAuth, requireApproval, async (req, res) => {
  const { url, title, icon, isPublic, isProtected } = req.body;

  if (!url) return res.redirect('/dashboard');

  try {
    const publicVal = (isPublic === 'on' || isPublic === '1' || isPublic === true || isPublic === 1) ? 1 : 0;
    const protectedVal = (isProtected === 'on' || isProtected === '1' || isProtected === true || isProtected === 1) ? 1 : 0;

    console.log(`[Bookmark] Saving bookmark for user ${req.user.username}:`, {
      url,
      title,
      isPublic: publicVal,
      isProtected: protectedVal
    });

    db.createBookmark(req.user.id, url.trim(), title ? title.trim() : '', icon ? icon.trim() : '', publicVal, protectedVal);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('[Bookmark] Error creating bookmark:', err);
    res.redirect('/dashboard?error=Failed to save bookmark');
  }
});

app.post('/bookmarks/delete', requireAuth, (req, res) => {
  const { id } = req.body;
  db.deleteBookmark(id, req.user.id);
  console.log(`[Bookmark] Deleted bookmark ID ${id} for user ${req.user.username}`);
  res.redirect('/dashboard');
});

// --- PIN SETTING ---
app.post('/settings/pin', requireAuth, (req, res) => {
  const { pin } = req.body;
  if (!pin || pin.length < 4) return res.redirect('/dashboard?error=Pin must be at least 4 digits');
  const hashedPin = bcrypt.hashSync(pin, 10);
  db.setUserPin(req.user.id, hashedPin);
  console.log(`[Pin] Security PIN updated for user ${req.user.username}`);
  res.redirect('/dashboard');
});

// --- PIN VERIFICATION (Homepage Vault) ---
app.post('/api/verify-pin', async (req, res) => {
  const { pin, username } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });

  let user = null;

  if (username) {
    user = db.findUserByUsername(username);
  } else if (req.cookies.token) {
    try {
      const payload = jwt.verify(req.cookies.token, JWT_SECRET);
      user = db.findUserById(payload.id);
    } catch (e) {}
  }

  // If still not identified, search users that match the pin
  if (!user) {
    const allUsers = db.getAllUsers();
    for (const u of allUsers) {
      const fullUser = db.findUserById(u.id);
      if (fullUser && fullUser.pin && bcrypt.compareSync(pin, fullUser.pin)) {
        const protectedLinks = db.getProtectedBookmarks(fullUser.id);
        return res.json({ success: true, links: protectedLinks, author: fullUser.username });
      }
    }
    return res.status(403).json({ error: 'Incorrect PIN or vault not configured' });
  }

  if (!user.pin) return res.status(403).json({ error: 'Vault PIN not configured for this user' });

  const isValid = bcrypt.compareSync(pin, user.pin);
  if (!isValid) return res.status(403).json({ error: 'Incorrect PIN' });

  const protectedLinks = db.getProtectedBookmarks(user.id);
  return res.json({ success: true, links: protectedLinks, author: user.username });
});

// --- START SERVER (Guideline 6: use port.txt, else find/save available port) ---
const startServer = (preferredPort) => {
  const server = app.listen(preferredPort, function () {
    const address = this.address();
    if (!address) return;
    const actualPort = address.port;
    console.log(`[Server] Apps Loader running at http://localhost:${actualPort}`);
    try {
      fs.writeFileSync(PORT_FILE, actualPort.toString(), 'utf-8');
      console.log(`[Server] Saved active port ${actualPort} to ${PORT_FILE}`);
    } catch (e) {
      console.error('[Server] Could not write to port file:', e.message);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[Server] Port ${preferredPort} in use, finding available dynamic port...`);
      startServer(0);
    } else {
      console.error('[Server] Unexpected server error:', err);
    }
  });
};

let portToUse = 3000;
if (fs.existsSync(PORT_FILE)) {
  try {
    const saved = parseInt(fs.readFileSync(PORT_FILE, 'utf-8').trim(), 10);
    if (!isNaN(saved) && saved > 0) portToUse = saved;
  } catch (err) {
    console.error('[Server] Failed to read port.txt, falling back to 3000');
  }
}
startServer(portToUse);