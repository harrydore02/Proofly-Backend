// lib/stats/getUserStats.js

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

// ─── Validation ────────────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateInput({ userId }) {
  if (!userId || !UUID_REGEX.test(userId)) {
    throw new ValidationError('A valid userId is required.');
  }
  return { userId };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the duration of a session in minutes, or 0 if timestamps are invalid.
 */
function sessionDurationMinutes(startTime, endTime) {
  const start = new Date(startTime).getTime();
  const end   = new Date(endTime).getTime();

  if (isNaN(start) || isNaN(end) || end <= start) return 0;

  return Math.round((end - start) / 1000 / 60);
}

/**
 * Counts consecutive completed sessions from most recent backwards.
 * A streak is broken by any non-completed terminal session (failed).
 * In-progress sessions (locked, submitted, not_started) are skipped.
 */
function calculateStreak(sessions) {
  let streak = 0;

  for (const session of sessions) {
    if (session.status === 'completed') {
      streak++;
    } else if (session.status === 'failed') {
      break;
    }
    // locked / submitted / not_started: skip (don't break streak)
  }

  return streak;
}

// ─── Core Logic ────────────────────────────────────────────────────────────────

/**
 * Calculates aggregated focus stats for a Proofly user.
 *
 * @param {Object} input
 * @param {string} input.userId - The user to calculate stats for.
 * @returns {Promise<Object>}   Structured stats object.
 */
export async function getUserStats({ userId }) {
  const validated = validateInput({ userId });

  // Single query — fetch all terminal + active sessions ordered newest first
  const { data: sessions, error } = await supabase
    .from('focus_sessions')
    .select('id, status, start_time, end_time')
    .eq('user_id', validated.userId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error('Failed to fetch sessions.');
  }

  if (!sessions || sessions.length === 0) {
    throw new NotFoundError('No sessions found for this user.');
  }

  // ── Aggregate ──────────────────────────────────────────────────────────────

  let completedSessions = 0;
  let failedSessions    = 0;
  let totalFocusMinutes = 0;

  for (const session of sessions) {
    if (session.status === 'completed') {
      completedSessions++;
      totalFocusMinutes += sessionDurationMinutes(session.start_time, session.end_time);
    } else if (session.status === 'failed') {
      failedSessions++;
    }
  }

  const currentStreak = calculateStreak(sessions);

  // ── Format ─────────────────────────────────────────────────────────────────

  const totalFocusHours   = Math.floor(totalFocusMinutes / 60);
  const remainingMinutes  = totalFocusMinutes % 60;
  const completionRate    = sessions.length > 0
    ? Math.round((completedSessions / sessions.length) * 100)
    : 0;

  return {
    user_id: validated.userId,
    stats: {
      total_sessions:     sessions.length,
      completed_sessions: completedSessions,
      failed_sessions:    failedSessions,
      completion_rate_pct: completionRate,
      total_focus_time: {
        minutes: totalFocusMinutes,
        formatted: `${totalFocusHours}h ${remainingMinutes}m`,
      },
      current_streak: currentStreak,
    },
  };
}

// ─── HTTP Handler ──────────────────────────────────────────────────────────────

/**
 * GET /api/users/:userId/stats
 *
 * Auth: expects req.user.id set by your auth middleware
 */
export async function handleGetUserStats(req, res) {
  try {
    // Users can only fetch their own stats
    if (req.params.userId !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Forbidden.' });
    }

    const result = await getUserStats({ userId: req.params.userId });

    return res.status(200).json({ success: true, ...result });

  } catch (err) {
    const known = ['ValidationError', 'NotFoundError'];

    if (known.includes(err.name)) {
      return res.status(err.statusCode).json({ success: false, error: err.message });
    }

    console.error('[getUserStats] Unexpected error:', err);

    return res.status(500).json({
      success: false,
      error: 'An unexpected error occurred. Please try again.',
    });
  }
}
