import jwt from 'jsonwebtoken';
import * as db from './db.js';

const SECRET_KEY = process.env.JWT_SECRET || 'super-secret-key-change-this-in-prod';

export const generateToken = (user) => {
  return jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: '60d' });
};

export const requireAuth = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.redirect('/login');

  try {
    const payload = jwt.verify(token, SECRET_KEY);
    const user = db.findUserById(payload.id);

    if (!user) {
      res.clearCookie('token');
      return res.redirect('/login');
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('[Auth] Token verification failed:', err.message);
    res.clearCookie('token');
    return res.redirect('/login');
  }
};

export const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).render('error', { message: 'Access Denied: Admins Only' });
  }
};

export const requireApproval = (req, res, next) => {
  if (req.user && req.user.is_approved === 1) {
    next();
  } else {
    res.status(403).render('error', { message: 'Account Pending Approval' });
  }
};