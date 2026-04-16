
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { handleStartSession }  from './startSession.js';
import { handleVerifyProof }   from './verifyProof.js';
import { handleFinalizeSession } from './finalizeSession.js';
import { handleEmergencyUnlock } from './emergencyUnlock.js';
import { handleGetUserStats }  from './getUserStats.js';
import { submitProof }         from './submitProof.js';
import { verifyProof }         from './verifyProof.js';
import { finalizeSession }     from './finalizeSession.js';

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/sessions/start', requireAuth, handleStartSession);

app.post('/api/sessions/submit-proof', requireAuth, async (req, res) => {
  try {
    const submitted = await submitProof({
      sessionId:     req.body.session_id,
      userId:        req.user.id,
      proofImageUrl: req.body.proof_image_url ?? null,
      proofText:     req.body.proof_text      ?? null,
    });
    const verdict = await verifyProof({
      task:          submitted.task,
      proofImageUrl: submitted.proof_image_url,
      proofText:     submitted.proof_text,
    });
    const final = await finalizeSession({
      sessionId: submitted.id,
      userId:    req.user.id,
      result:    verdict,
    });
    return res.status(200).json({ success: true, session: final });
  } catch (err) {
    const known = ['ValidationError', 'NotFoundError', 'ConflictError', 'AIVerificationError'];
    if (known.includes(err.name)) {
      return res.status(err.statusCode).json({ success: false, error: err.message });
    }
    console.error('[submit-proof] Unexpected error:', err);
    return res.status(500).json({ success: false, error: 'An unexpected error occurred.' });
  }
});

app.post('/api/sessions/verify-proof',     requireAuth, handleVerifyProof);
app.post('/api/sessions/finalize',         requireAuth, handleFinalizeSession);
app.post('/api/sessions/emergency-unlock', requireAuth, handleEmergencyUnlock);
app.get ('/api/users/:userId/stats',       requireAuth, handleGetUserStats);

app.listen(PORT, () => console.log(`Proofly backend running on port ${PORT}`));
