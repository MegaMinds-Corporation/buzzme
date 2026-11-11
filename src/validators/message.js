'use strict';

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

module.exports = { validateMessage, MESSAGE_MAX_CHARS };
