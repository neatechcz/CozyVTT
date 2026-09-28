/**
 * Proving a file really is text.
 *
 * `file-type` identifies files by magic bytes, and plain text has none. So a
 * `.txt` or `.md` upload reaches the "could not identify this" branch of the
 * validator, and the question is what to do there. Accepting on extension alone
 * is the classic hole: any payload uploads as `.md`. Instead the bytes have to
 * prove they are text.
 *
 * The bar: decodable as UTF-8, no NUL bytes, no control characters beyond the
 * whitespace a text file uses. An HTML file passes, and should, because it is
 * text. What stops it doing harm is how it is served, not whether it is stored.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { isPlainTextFile } from '../textFile';

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cozyvtt-textfile-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(name: string, bytes: Buffer | string): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, bytes);
  return p;
}

describe('isPlainTextFile', () => {
  describe('accepts what a person would call text', () => {
    it('plain ASCII', async () => {
      expect(await isPlainTextFile(await write('a.txt', 'hello world\nline two\n'))).toBe(true);
    });

    it('Markdown', async () => {
      expect(
        await isPlainTextFile(await write('b.md', '# Title\n\nSome *emphasis* and a [link](x).\n'))
      ).toBe(true);
    });

    it('UTF-8 with accents, CJK and emoji', async () => {
      expect(await isPlainTextFile(await write('c.txt', 'café — 日本語 — 🎲\n'))).toBe(true);
    });

    it('a UTF-8 byte order mark', async () => {
      const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom\n')]);
      expect(await isPlainTextFile(await write('d.txt', bom))).toBe(true);
    });

    it('Windows line endings and tabs', async () => {
      expect(await isPlainTextFile(await write('e.txt', 'col\tcol\r\nrow\r\n'))).toBe(true);
    });

    it('a form feed, which some text files use as a page break', async () => {
      expect(await isPlainTextFile(await write('f.txt', 'page one\fpage two\n'))).toBe(true);
    });

    it('an empty file', async () => {
      expect(await isPlainTextFile(await write('g.txt', ''))).toBe(true);
    });

    it('HTML, because it is text and the serving layer is what neutralises it', async () => {
      expect(
        await isPlainTextFile(await write('h.md', '<html><script>alert(1)</script></html>'))
      ).toBe(true);
    });
  });

  describe('refuses what only claims to be text', () => {
    it('an executable renamed .md', async () => {
      const elf = await fs.readFile('/bin/ls');
      expect(await isPlainTextFile(await write('ls.md', elf))).toBe(false);
    });

    it('NUL bytes anywhere, including after a long text preamble', async () => {
      const nuls = Buffer.from([0x74, 0x65, 0x78, 0x74, 0x00, 0x77, 0x69, 0x74, 0x68, 0x00, 0x6e, 0x75, 0x6c, 0x73]);
      expect(await isPlainTextFile(await write('i.txt', nuls))).toBe(false);
      const late = Buffer.concat([Buffer.from('a'.repeat(5000)), Buffer.from([0x00])]);
      expect(await isPlainTextFile(await write('j.txt', late))).toBe(false);
    });

    it('bytes that are not valid UTF-8', async () => {
      const bad = Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x21]);
      expect(await isPlainTextFile(await write('k.txt', bad))).toBe(false);
    });

    it('control characters that do not appear in text', async () => {
      // 0x01 through 0x08 never occur in a text file; 0x1b is an escape sequence.
      expect(await isPlainTextFile(await write('l.txt', Buffer.from([0x61, 0x01, 0x62, 0x02, 0x63])))).toBe(false);
      expect(await isPlainTextFile(await write('m.txt', Buffer.from([0x6f, 0x6b, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x42, 0x41, 0x44])))).toBe(false);
    });

    it('a PDF, which is binary despite its readable header', async () => {
      const pdf = Buffer.concat([
        Buffer.from('%PDF-1.4\n'),
        Buffer.from([0x00, 0x01, 0xff]),
        Buffer.from('\n%%EOF'),
      ]);
      expect(await isPlainTextFile(await write('n.txt', pdf))).toBe(false);
    });
  });

  it('answers false for a file that does not exist, and does not throw', async () => {
    await expect(isPlainTextFile(path.join(dir, 'missing.txt'))).resolves.toBe(false);
  });
});
