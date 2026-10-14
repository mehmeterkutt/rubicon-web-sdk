import { spawnSync } from 'node:child_process';

/** What Python made of one line: the parsed value, or why it refused the line. */
export type PythonParse =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

// Reads the lines as bytes, decodes each with strict UTF-8 and parses it with the standard `json`
// module, refusing the `NaN` and `Infinity` tokens it would otherwise accept; answers one ASCII
// JSON line per input line. Standard library only.
const SCRIPT = `
import json, sys

def refuse(token):
    raise ValueError("not JSON: " + token)

answers = []
for raw in sys.stdin.buffer.read().split(b"\\n"):
    try:
        value = json.loads(raw.decode("utf-8", "strict"), parse_constant=refuse)
        answers.append(json.dumps({"ok": value}, ensure_ascii=True, allow_nan=False))
    except Exception as error:
        answers.append(json.dumps({"error": type(error).__name__ + ": " + str(error)}, ensure_ascii=True))
sys.stdout.write("\\n".join(answers))
`;

/**
 * Parses each line with Python 3's `json` after a strict UTF-8 decode: the independent parser of
 * Web Serialization 3 (D9), the counterpart of Android's `kotlinx-serialization-json` check.
 *
 * The lines are sent as their UTF-8 bytes, joined with `\n` as in a chunk, except that a lone
 * surrogate is sent as the three bytes of its code unit rather than the U+FFFD that Node's encoder
 * would put there silently, so a line that would not be valid UTF-8 is refused instead of repaired.
 * A line holding a raw `\n` arrives as two lines and fails the count.
 *
 * Python runs isolated (`-I`: no environment variables, user site packages or current directory on
 * the path). Python missing or failing throws, so a test that needs it fails rather than skips;
 * `executable` exists to prove that.
 */
export function parseWithPython(lines: readonly string[], executable = 'python3'): PythonParse[] {
  if (lines.length === 0) return [];
  const result = spawnSync(executable, ['-I', '-c', SCRIPT], {
    input: Buffer.concat(lines.map((line, i) => encodeKeepingSurrogates(i === 0 ? line : `\n${line}`))),
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.error !== undefined) throw new Error(`Python 3 is required to run this test: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${executable} exited with ${String(result.status)}: ${result.stderr.toString()}`);
  const answers = result.stdout.toString('utf8').split('\n');
  if (answers.length !== lines.length) {
    throw new Error(`${executable} answered ${String(answers.length)} lines for ${String(lines.length)}`);
  }
  return answers.map((answer) => {
    const parsed = JSON.parse(answer) as { ok?: unknown; error?: string };
    return 'error' in parsed ? { ok: false, error: String(parsed.error) } : { ok: true, value: parsed.ok };
  });
}

/** UTF-8, with a lone surrogate written as the three bytes of its code unit (invalid UTF-8). */
function encodeKeepingSurrogates(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let point = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);
    if (point >= 0xd800 && point <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      point = 0x10000 + (point - 0xd800) * 0x400 + (next - 0xdc00);
      i += 1;
    }
    if (point < 0x80) bytes.push(point);
    else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    else if (point < 0x10000) bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    else
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
  }
  return Buffer.from(bytes);
}
