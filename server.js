import express from 'express';
import { handleStartSession }    from './startSession.js';
import { handleSubmitProof }     from './submitProof.js';
import { handleVerifyProof }     from './verifyProof.js';
import { handleFinalizeSession } from './finalizeSession.js';
import { handleEmergencyUnlock } from './emergencyUnlock.js';
import { handleGetUserStats }    from './getUserStats.js';

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ─── Auth middleware ───────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized.' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ success: false, error: 'Invalid token.' });

  req.user = user;
  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/sessions/start',            requireAuth, handleStartSession);
app.post('/api/sessions/submit-proof',     requireAuth, handleSubmitProof);
app.post('/api/sessions/verify-proof',     requireAuth, handleVerifyProof);
app.post('/api/sessions/finalize',         requireAuth, handleFinalizeSession);
app.post('/api/sessions/emergency-unlock', requireAuth, handleEmergencyUnlock);
app.get ('/api/users/:userId/stats',       requireAuth, handleGetUserStats);

app.listen(PORT, () => console.log(`Proofly backend running on port ${PORT}`));
