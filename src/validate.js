'use strict';

const MODES = ['video', 'voice', 'text'];
// 2-20 characters: letters, numbers, underscore, hyphen, space (any language).
const NICKNAME_RE = /^[\p{L}\p{N}_\- ]{2,20}$/u;

// Returns { ok: true, value: { nickname, mode, deviceToken } } or { ok: false }.
function validateJoin(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false };
  }

  // 18+ confirmation is required before the first match (spec section 8). Only the
  // boolean true counts: "true", 1 or a missing field do not.
  if (payload.ageConfirmed !== true) return { ok: false };

  if (typeof payload.nickname !== 'string') return { ok: false };
  const nickname = payload.nickname.trim().replace(/\s+/g, ' ');
  if (!NICKNAME_RE.test(nickname)) return { ok: false };

  const mode = payload.mode === undefined ? 'video' : payload.mode; // video is the default (spec section 5)
  if (!MODES.includes(mode)) return { ok: false };

  let deviceToken = null;
  if (payload.deviceToken !== undefined) {
    const t = payload.deviceToken;
    if (typeof t !== 'string' || t.length < 1 || t.length > 128) return { ok: false };
    deviceToken = t;
  }

  return { ok: true, value: { nickname, mode, deviceToken } };
}

// One chat message is at most this many characters (Unicode code points, so an emoji
// counts as 1). The socket-level 32 KB cap still applies on top of this.
const MESSAGE_MAX_CHARS = 500;

// Rejected inside chat text: control characters (newline and tab are allowed) and the
// Unicode bidi override/isolate characters, which can make text display backwards or
// disguise other text.
const BAD_TEXT_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

// Returns { ok: true, value: text } or { ok: false }. Messages are plain text only:
// the client must render them as text, never as HTML. Line endings are normalised to
// \n and surrounding whitespace is trimmed; nothing else is changed.
function validateMessage(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false };
  }
  if (typeof payload.text !== 'string') return { ok: false };

  const text = payload.text.replace(/\r\n?/g, '\n').trim();
  if (text === '') return { ok: false };
  // Cheap early exit: a code point is at most 2 UTF-16 units, so more than twice the
  // limit in units is certainly too long. Only then is the exact count worth doing.
  if (text.length > MESSAGE_MAX_CHARS * 2) return { ok: false };
  if ([...text].length > MESSAGE_MAX_CHARS) return { ok: false };
  if (BAD_TEXT_RE.test(text)) return { ok: false };

  return { ok: true, value: text };
}

module.exports = { validateJoin, validateMessage, MODES, MESSAGE_MAX_CHARS };
