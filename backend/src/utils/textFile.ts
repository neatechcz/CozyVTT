/**
 * Whether a file's bytes are genuinely text.
 *
 * Plain text and Markdown have no magic bytes, so `file-type` cannot identify
 * them and an upload of either reaches the validator's "could not identify this"
 * branch. Accepting on extension there would let any payload upload as `.md`.
 * This is the positive check instead: the bytes must decode as UTF-8, contain no
 * NUL, and use no control characters beyond the whitespace text files use.
 *
 * It reads the whole file. A check on a prefix could be defeated by a text
 * preamble followed by anything, and uploads are already bounded by the size
 * limit, so reading everything costs little and answers the real question.
 *
 * An HTML file passes. It is text, and this is not where it is made safe; the
 * serving route sends documents as `text/plain` with sniffing disabled, so the
 * browser never treats one as a page.
 */

import { promises as fs } from 'fs';

/** Tab, line feed, form feed, carriage return. Everything else below 0x20 is refused. */
const TEXT_WHITESPACE = new Set([0x09, 0x0a, 0x0c, 0x0d]);

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

export async function isPlainTextFile(filePath: string): Promise<boolean> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch {
    return false;
  }
  return isPlainTextBuffer(bytes);
}

/** The same check on bytes already in memory, for tests and for callers that have them. */
export function isPlainTextBuffer(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    // NUL and the C0 controls that never appear in text, plus DEL.
    if ((b < 0x20 && !TEXT_WHITESPACE.has(b)) || b === 0x7f) {
      return false;
    }
  }

  try {
    strictUtf8.decode(bytes);
  } catch {
    return false;
  }

  return true;
}
