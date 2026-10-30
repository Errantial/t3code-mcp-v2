import type { Message } from "./model.js";

/**
 * Message text is capped when it is returned. The caps keep a single MCP
 * response small enough to be useful in a chat/voice loop; `get_message` reads
 * any message in full, slice by slice, using the ids `get_thread` and
 * `wait_for_turn` return.
 */

/** Hard ceiling for one slice; larger requests are clamped to this. */
export const MAX_MESSAGE_CHARS_CEILING = 100_000;

/** Per-call fallbacks, used when neither the caller nor the env var sets a cap. */
export const MESSAGE_DEFAULTS = {
  /** `get_thread` row cap. */
  threadRow: 4000,
  /** `wait_for_turn` reply cap. */
  waitReply: 6000,
  /** `get_message` slice cap. */
  getMessage: 20_000,
} as const;

/** Environment override: `T3_MCP_MAX_MESSAGE_CHARS=20000`. */
export const MAX_MESSAGE_CHARS_ENV = "T3_MCP_MAX_MESSAGE_CHARS";

/** Positive integer from the env var, or undefined when unset/invalid. */
export function envMaxChars(): number | undefined {
  const raw = process.env[MAX_MESSAGE_CHARS_ENV]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return undefined;
  return Math.min(value, MAX_MESSAGE_CHARS_CEILING);
}

/**
 * Resolve one effective cap. Precedence: explicit argument, then
 * `T3_MCP_MAX_MESSAGE_CHARS`, then the caller's built-in default.
 */
export function resolveMaxChars(fallback: number, override?: number): number {
  const requested = override ?? envMaxChars() ?? fallback;
  const integer = Math.trunc(requested);
  if (!Number.isFinite(integer) || integer < 1) return fallback;
  return Math.min(integer, MAX_MESSAGE_CHARS_CEILING);
}

export interface MessageSlice {
  messageId: string;
  role: Message["role"];
  at: string;
  /** Full message length, independent of offset and cap. */
  totalChars: number;
  /** Index of the first character in `text`. */
  offset: number;
  /** The requested slice, without an ellipsis, so slices concatenate exactly. */
  text: string;
  /** Offset to pass to the next call, or null when the message is exhausted. */
  nextOffset: number | null;
  /** True when text remains after this slice. */
  truncated: boolean;
}

/**
 * Slice a message for `get_message`. `offset` past the end clamps to the end and
 * returns empty text rather than throwing, so a caller paging in a loop always
 * terminates. An offset of 0 with a cap >= totalChars returns the whole message
 * with `truncated: false` and `nextOffset: null`.
 */
export function sliceMessage(
  message: Message,
  options: { offset?: number; maxChars?: number } = {},
): MessageSlice {
  const full = message.text ?? "";
  const totalChars = full.length;
  const requestedOffset = Math.trunc(options.offset ?? 0);
  const offset = Math.min(
    Math.max(Number.isFinite(requestedOffset) ? requestedOffset : 0, 0),
    totalChars,
  );
  const limit = resolveMaxChars(MESSAGE_DEFAULTS.getMessage, options.maxChars);
  const text = full.slice(offset, offset + limit);
  const end = offset + text.length;
  const hasMore = end < totalChars;
  return {
    messageId: message.id,
    role: message.role,
    at: message.createdAt,
    totalChars,
    offset,
    text,
    nextOffset: hasMore ? end : null,
    truncated: hasMore,
  };
}
