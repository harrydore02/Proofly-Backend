// lib/sessions/emergencyUnlock.js

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Error Types ───────────────────────────────────────────────────────────────

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
  }
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Statuses that can be force-exited
const UNLOCKABLE_STATUSES = ['locked', 'submitted'];

// ─── Validation ────────────────────────────────────────────────────────────────

function validateUnlockInput({ sessionId, userId }) {
  if (!sessionId || !UUID_REGEX.test(sessionId)) {
    throw new ValidationError('A valid sessionId is required.');
  }

  if (!userId || typeof userId !== 'string') {
    throw new ValidationError('userId is required.');
  }

  return { sessionId, userId };
}

// ─── Core Logic ────────────────────────────────────────────────────────────────

/**
 * Emergency-unlocks an active Proofly session, marking it as failed.
 * Available for sessions in "locked" or "submitted" state.
 *
 * @param {Object} input
 * @param {string} input.sessionId  - Session to force-exit.
 * @param {string} input.userId     - Must match the session owner.
 * @returns {Promise<Object>}       The updated session record.
 */
export async function emergencyUnlock({ sessionId, userId }) {
  const validated = validateUnlockInput({ sessionId, userId });

  const { data: session, error: fetchError } = await supabase
    .from('focus_sessions')
    .select('id, user_id, status')
    .eq('id', validated.sessionId)
    .single();

  if (fetchError || !session) {
    throw new NotFoundError('Session not found.');
  }

  if (session.user_id !== validated.userId) {
    throw new NotFoundError('Session not found.');
  }

  if (!UNLOCKABLE_STATUSES.includes(session.status)) {
    throw new ConflictError(
      `Only active sessions can be emergency-unlocked. Current status: "${session.status}".`
    );
  }

  const { data: updated, error: updateError } = await supabase
    .from('focus_sessions')
    .update({
      status:   'failed',
      end_time: new Date().toISOString(),
    })
    .eq('id', validated.sessionId)
    .select()
    .single();

  if (updateError) {
    throw new Error('Failed to unlock session.');
  }

  return updated;
}

// ─── HTTP Handler ──────────────────────────────────────────────────────────────

/**
 * POST /api/sessions/emergency-unlock
 *
 * Body: { session_id }
 * Auth: expects req.user.id set by your auth middleware
 */
export async function handleEmergencyUnlock(req, res) {
  try {
    const session = await emergencyUnlock({
      sessionId: req.body.session_id,
      userId:    req.user.id,
    });

    return res.status(200).json({ success: true, session });

  } catch (err) {
    const known = ['ValidationError', 'NotFoundError', 'ConflictError'];

    if (known.includes(err.name)) {
      return res.status(err.statusCode).json({ success: false, error: err.message });
    }

    console.error('[emergencyUnlock] Unexpected error:', err);

    return res.status(500).json({
      success: false,
      error: 'An unexpected error occurred. Please try again.',
    });
  }
}
