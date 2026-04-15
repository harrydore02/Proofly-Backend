// lib/sessions/submitProof.js

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

// ─── Validation ────────────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_REGEX  = /^https?:\/\/.+/i;

function validateSubmitProofInput({ sessionId, userId, proofImageUrl, proofText }) {
  if (!sessionId || !UUID_REGEX.test(sessionId)) {
    throw new ValidationError('A valid sessionId is required.');
  }

  if (!userId || typeof userId !== 'string') {
    throw new ValidationError('userId is required.');
  }

  const trimmedText = proofText?.trim() ?? null;
  const trimmedUrl  = proofImageUrl?.trim() ?? null;

  if (!trimmedText && !trimmedUrl) {
    throw new ValidationError('At least one proof must be provided: proof_text or proof_image_url.');
  }

  if (trimmedUrl && !URL_REGEX.test(trimmedUrl)) {
    throw new ValidationError('proof_image_url must be a valid URL.');
  }

  if (trimmedText && trimmedText.length > 2000) {
    throw new ValidationError('proof_text must be 2000 characters or fewer.');
  }

  return {
    sessionId,
    userId,
    proofImageUrl: trimmedUrl,
    proofText:     trimmedText,
  };
}

// ─── Core Logic ────────────────────────────────────────────────────────────────

/**
 * Submits proof for an active Proofly focus session.
 *
 * @param {Object}      input
 * @param {string}      input.sessionId      - The session being completed.
 * @param {string}      input.userId         - Must match the session owner.
 * @param {string|null} input.proofImageUrl  - URL of the uploaded proof image.
 * @param {string|null} input.proofText      - Written proof note.
 * @returns {Promise<Object>} The updated session record.
 */
export async function submitProof({ sessionId, userId, proofImageUrl, proofText }) {
  const validated = validateSubmitProofInput({ sessionId, userId, proofImageUrl, proofText });

  // Fetch the session and verify ownership in one query
  const { data: session, error: fetchError } = await supabase
    .from('focus_sessions')
    .select('id, user_id, status')
    .eq('id', validated.sessionId)
    .single();

  if (fetchError || !session) {
    throw new NotFoundError('Session not found.');
  }

  if (session.user_id !== validated.userId) {
    // Return 404 rather than 403 — don't confirm the session exists to other users
    throw new NotFoundError('Session not found.');
  }

  if (session.status !== 'locked') {
    throw new ConflictError(
      `Proof can only be submitted for a locked session. Current status: "${session.status}".`
    );
  }

  // Apply the update
  const { data: updated, error: updateError } = await supabase
    .from('focus_sessions')
    .update({
      status:          'submitted',
      proof_image_url: validated.proofImageUrl,
      proof_text:      validated.proofText,
    })
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
 * POST /api/sessions/submit-proof
 *
 * Body: { session_id, proof_image_url?, proof_text? }
 * Auth: expects req.user.id set by your auth middleware
 */
export async function handleSubmitProof(req, res) {
  try {
    const session = await submitProof({
      sessionId:     req.body.session_id,
      userId:        req.user.id,
      proofImageUrl: req.body.proof_image_url ?? null,
      proofText:     req.body.proof_text      ?? null,
    });

    return res.status(200).json({ success: true, session });

  } catch (err) {
    const known = ['ValidationError', 'NotFoundError', 'ConflictError'];

    if (known.includes(err.name)) {
      return res.status(err.statusCode).json({ success: false, error: err.message });
    }

    console.error('[submitProof] Unexpected error:', err);

    return res.status(500).json({
      success: false,
      error: 'An unexpected error occurred. Please try again.',
    });
  }
}
