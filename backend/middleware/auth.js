import { db } from '../utils/db.js';

export const requireAuth = async (req, res, next) => {
  // Session check to avoid IDOR/BOLA: Verify session contains logged-in user
  if (!req.session || !req.session.user || !req.session.user.id) {
    return res.status(401).json({ error: 'Unauthorized: Active session required.' });
  }

  const userId = req.session.user.id;
  const currentSid = req.sessionID;

  // Single-Device Enforcement: Ensure the user's recorded session ID matches this session
  const { rows } = await db.query(
    'SELECT id, email, role, full_name, current_session_id FROM users WHERE id = $1',
    [userId]
  );

  if (rows.length === 0) {
    req.session.destroy();
    return res.status(401).json({ error: 'User not found or account removed.' });
  }

  const user = rows[0];

  // If another login has occurred, current_session_id in DB will differ
  if (user.current_session_id && user.current_session_id !== currentSid) {
    req.session.destroy();
    return res.status(401).json({
      error: 'Concurrent Session Terminated: Your account was logged in from another device or browser window.',
      code: 'CONCURRENT_LOGIN_TERMINATED'
    });
  }

  // Attach verified user directly to req for safe role checks
  req.currentUser = user;
  next();
};

export const requireRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.currentUser) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    if (!allowedRoles.includes(req.currentUser.role)) {
      return res.status(403).json({
        error: `Forbidden: Access restricted. Required role: [${allowedRoles.join(', ')}], your role: [${req.currentUser.role}]`
      });
    }

    next();
  };
};
