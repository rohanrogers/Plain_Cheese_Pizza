import express from 'express';
import cors from 'cors';
import session from 'express-session';
import dotenv from 'dotenv';
import { DatabaseSessionStore } from './utils/sessionStore.js';
import { seedInitialUsers } from './seed.js';

dotenv.config();

import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';

const app = express();

app.use(express.json());
app.use(
  cors({
    origin: ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'],
    credentials: true
  })
);

app.use(
  session({
    store: new DatabaseSessionStore(),
    secret: process.env.SESSION_SECRET || 'brightloop_super_secure_session_secret_2026',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false, // set true in production with HTTPS
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 // 24 hours
    }
  })
);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  console.log(`🚀 Brightloop IAM Service listening on http://localhost:${PORT}`);
  await seedInitialUsers();
});
