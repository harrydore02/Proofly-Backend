// lib/sessions/verifyProof.js

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Error Types ───────────────────────────────────────────────────────────────

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

class AIVerificationError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'AIVerificationError';
    this.statusCode = 502;
    this.cause = cause;
  }
}

// ─── Prompt ────────────────────────────────────────────────────────────────────

function buildVerificationPrompt(task) {
  return `You are a strict but fair proof-of-work verifier for a productivity app called Proofly.

A user committed to completing the following task:
"${task}"

You will be given evidence — either an image, written text, or both — that the user claims proves task completion.

Your job is to decide whether the evidence reasonably demonstrates the task was completed.

RULES:
- Be strict but fair. Partial or clearly unrelated proof should be rejected.
- Do not require perfect proof. Reasonable, plausible evidence is sufficient.
- Ignore effort, excuses, or sentiment. Only evaluate what the proof actually shows.
- If no meaningful proof is provided, reject it.
- Your response must be exactly one word: approved or rejected.
- Do not explain. Do not add punctuation. Do not say anything else.`;
}

// ─── Input Validation ──────────────────────────────────────────────────────────

function validateVerifyProofInput({ task, proofImageUrl, proofText }) {
  if (!task?.trim()) {
    throw new ValidationError('task is required.');
  }

  if (!proofImageUrl?.trim() && !proofText?.trim()) {
    throw new ValidationError('At least one proof must be provided: proofImageUrl or proofText.');
  }

  const URL_REGEX = /^https?:\/\/.+/i;
  if (proofImageUrl && !URL_REGEX.test(proofImageUrl.trim())) {
    throw new ValidationError('proofImageUrl must be a valid URL.');
  }

  return {
    task:          task.trim(),
    proofImageUrl: proofImageUrl?.trim() ?? null,
    proofText:     proofText?.trim()     ?? null,
  };
}

// ─── Message Builder ───────────────────────────────────────────────────────────

function buildUserMessage({ proofImageUrl, proofText }) {
  // Text-only: send a plain text message
  if (!proofImageUrl) {
    return {
      role: 'user',
      content: `Proof (text only):\n\n${proofText}`,
    };
  }

  // Image (+ optional text): use the vision content block format
  const content = [
    {
      type: 'image_url',
      image_url: { url: proofImageUrl, detail: 'low' },
    },
  ];

  if (proofText) {
    content.push({
      type: 'text',
      text: `Additional written note from the user:\n\n${proofText}`,
    });
  }

  return { role: 'user', content };
}

// ─── Core Logic ────────────────────────────────────────────────────────────────

/**
 * Uses OpenAI to verify whether submitted proof reasonably demonstrates
 * that a Proofly focus session task was completed.
 *
 * @param {Object}      input
 * @param {string}      input.task           - The original task the user committed to.
 * @param {string|null} input.proofImageUrl  - URL of the submitted proof image.
 * @param {string|null} input.proofText      - Written proof note.
 * @returns {Promise<'approved'|'rejected'>}
 */
export async function verifyProof({ task, proofImageUrl, proofText }) {
  const validated = validateVerifyProofInput({ task, proofImageUrl, proofText });

  const model = validated.proofImageUrl ? 'gpt-4o' : 'gpt-4o-mini';

  let response;
  try {
    response = await openai.chat.completions.create({
      model,
      max_tokens: 5,
      temperature: 0,               // deterministic — no creativity needed
      messages: [
        { role: 'system', content: buildVerificationPrompt(validated.task) },
        buildUserMessage(validated),
      ],
    });
  } catch (err) {
    throw new AIVerificationError('OpenAI request failed.', err);
  }

  const raw = response.choices?.[0]?.message?.content?.trim().toLowerCase();

  if (raw !== 'approved' && raw !== 'rejected') {
    // Unexpected model output — fail safe by rejecting
    console.warn('[verifyProof] Unexpected model output:', raw);
    return 'rejected';
  }

  return raw;
}

// ─── HTTP Handler ──────────────────────────────────────────────────────────────

/**
 * POST /api/sessions/verify-proof
 *
 * Body: { task, proof_image_url?, proof_text? }
 * Auth: expects req.user.id set by your auth middleware
 */
export async function handleVerifyProof(req, res) {
  try {
    const verdict = await verifyProof({
      task:          req.body.task,
      proofImageUrl: req.body.proof_image_url ?? null,
      proofText:     req.body.proof_text      ?? null,
    });

    return res.status(200).json({ success: true, verdict });

  } catch (err) {
    const known = ['ValidationError', 'AIVerificationError'];

    if (known.includes(err.name)) {
      return res.status(err.statusCode).json({ success: false, error: err.message });
    }

    console.error('[verifyProof] Unexpected error:', err);

    return res.status(500).json({
      success: false,
      error: 'An unexpected error occurred. Please try again.',
    });
  }
}
