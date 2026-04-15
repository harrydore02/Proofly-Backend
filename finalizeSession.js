// lib/sessions/finalizeSession.js

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

const VALID_RESULTS = ['approved', 'rejected'];
const UUID_REGEX    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Map: verification result → new session status
const RESULT_TO_STATUS = {
  approved: 'completed',
  rejected: 'locked',
};

// ─── Validation ────────────────────────────────────────────────────────────────

function validateFinalizeInput({ sessionId, userId, result }) {
  if (!sessionId || !UUID_REGEX.test(sessionId)) {
    throw new ValidationError('A valid sessionId is required.');
  }

  if (!userId || typeof userId !== 'string') {
    throw new ValidationError('userId is required.');
  }

  if (!VALID_RESULTS.includes(result)) {
    throw new ValidationError(`result must be one of: ${VALID_RESULTS.join(', ')}.`);
  }

  return { sessionId, userId, result };
}

// ─── Core Logic ────────────────────────────────────────────────────────────────

/**
 * Finalizes a Proofly session after AI proof verification.
 *
 * approved → status: "completed", end_time: now
 * rejected → status: "locked"   (proof cleared, user can resubmit)
 *
 * @param {Object}             input
 * @param {string}             input.sessionId  - Session to finalize.
 * @param {string}             input.userId     - Must match the session owner.
 * @param {'approved'|'rejected'} input.result  - Verdict from verifyProof().
 * @returns {Promise<Object>}  The updated session record.
 */
export async function finalizeSession({ sessionId, userId, result }) {
  const validated = validateFinalizeInput({ sessionId, userId, result });

  // Fetch session and verify ownership
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

  // Only "submitted" sessions are eligible for finalization
  if (session.status !== 'submitted') {
    throw new ConflictError(
      `Only submitted sessions can be finalized. Current status: "${session.status}".`
    );
  }

  const newStatus = RESULT_TO_STATUS[validated.result];

  const patch = {
    status:          newStatus,
    // On approval: stamp end_time. On rejection: clear proof so user can resubmit.
    ...(validated.result === 'approved'
      ? { end_time: new Date().toISOString() }
      : { proof_image_url: null, proof_text: null }
    ),
  };

  const { data: updated, error: updateError } = await supabase
    .from('focus_sessions')
    .update(patch)
    .eq('id', validated.sessionId)
    .select()
    .single();

  if (updateError) {
    throw new Error('Failed to update session.');
  }

  return updated;
}

// ─── HTTP Handler ──────────────────────────────────────────────────────────────

/**
 * POST /api/sessions/finalize
 *
 * Body: { session_id, result }
 * Auth: expects req.user.id set by your auth middleware
 *
 * Note: in production this endpoint would typically be called internally
 * (triggered by verifyProof), not exposed directly to the client.
 */
export async function handleFinalizeSession(req, res) {
  try {
    const session = await finalizeSession({
      sessionId: req.body.session_id,
      userId:    req.user.id,
      result:    req.body.result,
    });

    return res.status(200).json({ success: true, session });

  } catch (err) {
    const known = ['ValidationError', 'NotFoundError', 'ConflictError'];

    if (known.includes(err.name)) {
      return res.status(err.statusCode).json({ success: false, error: err.message });
    }

    console.error('[finalizeSession] Unexpected error:', err);

    return res.status(500).json({
      success: false,
      error: 'An unexpected error occurred. Please try again.',
    });
  }
}
