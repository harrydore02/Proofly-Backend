// lib/sessions/startSession.js

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Validation ────────────────────────────────────────────────────────────────

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

function validateStartSessionInput({ userId, task }) {
  if (!userId || typeof userId !== 'string') {
    throw new ValidationError('userId is required.');
  }

  const trimmedTask = task?.trim();

  if (!trimmedTask) {
    throw new ValidationError('Task cannot be empty.');
  }

  if (trimmedTask.length > 500) {
    throw new ValidationError('Task must be 500 characters or fewer.');
  }

  return { userId, task: trimmedTask };
}

// ─── Core Logic ────────────────────────────────────────────────────────────────

/**
 * Starts a new Proofly focus session for the given user.
 *
 * @param {Object} input
 * @param {string} input.userId - The authenticated user's ID.
 * @param {string} input.task   - What the user intends to accomplish.
 * @returns {Promise<Object>}   The newly created session record.
 */
export async function startSession({ userId, task }) {
  const validated = validateStartSessionInput({ userId, task });

  const { data: session, error } = await supabase
    .from('focus_sessions')
    .insert({
      user_id:    validated.userId,
      task:       validated.task,
      status:     'locked',
      start_time: new Date().toISOString(),
    })
    .select()
    .single();
console.log('Insert result:', JSON.stringify({ session, error }));

  if (error) {
    throw new DatabaseError('Failed to create session.', error);
  }

  return session;
}

class DatabaseError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'DatabaseError';
    this.statusCode = 500;
    this.cause = cause;
  }
}

// ─── HTTP Handler (e.g. Express / Next.js API route) ──────────────────────────

/**
 * POST /api/sessions/start
 *
 * Body: { task: string }
 * Auth: expects req.user.id set by your auth middleware
 */
export async function handleStartSession(req, res) {
  try {
    const session = await startSession({
      userId: req.user.id,
      task:   req.body.task,
    });

    return res.status(201).json({
      success: true,
      session,
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(err.statusCode).json({
        success: false,
        error:   err.message,
      });
    }

    console.error('[startSession] Unexpected error:', err);

    return res.status(500).json({
      success: false,
      error: 'An unexpected error occurred. Please try again.',
    });
  }
}
