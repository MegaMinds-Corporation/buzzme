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

module.exports = { validateJoin, MODES };