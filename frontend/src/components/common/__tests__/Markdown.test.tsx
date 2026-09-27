/**
 * The one Markdown renderer.
 *
 * Two kinds of promise. The features: tables render, and a single Enter is a
 * line break, because notes and documents are written by people at a table and
 * not by people who know CommonMark's soft-break rule. The safety: raw HTML is
 * shown as text and unsafe links lose their href. Both notes and documents
 * depend on all four, so they are pinned here once.
 *
 * The modal-free render means these assertions can look at the container
 * directly.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import Markdown from '../Markdown';

describe('Markdown', () => {
  describe('features people expect', () => {
    it('renders a GitHub-style table', () => {
      const { container } = render(
        <Markdown>{'| Type | Limit |\n|------|-------|\n| Map | 50 MB |\n| Token | 5 MB |'}</Markdown>
      );
      const table = container.querySelector('table');
      expect(table).not.toBeNull();
      expect(table?.querySelectorAll('th')).toHaveLength(2);
      expect(table?.querySelectorAll('td')).toHaveLength(4);
      expect(table?.textContent).toContain('50 MB');
    });

    it('turns a single newline into a line break', () => {
      const { container } = render(<Markdown>{'line one\nline two'}</Markdown>);
      // One paragraph, with a <br> between the lines, not one run-on line.
      expect(container.querySelectorAll('p')).toHaveLength(1);
      expect(container.querySelector('br')).not.toBeNull();
    });

    it('still makes a new paragraph from a blank line', () => {
      const { container } = render(<Markdown>{'para one\n\npara two'}</Markdown>);
      expect(container.querySelectorAll('p')).toHaveLength(2);
    });

    it('renders strikethrough and task lists', () => {
      const { container } = render(<Markdown>{'~~gone~~\n\n- [x] done\n- [ ] not yet'}</Markdown>);
      expect(container.querySelector('del')?.textContent).toBe('gone');
      const boxes = container.querySelectorAll('input[type="checkbox"]');
      expect(boxes).toHaveLength(2);
      // Task boxes are display only; a reader must not be able to tick them.
      boxes.forEach((b) => expect(b).toBeDisabled());
    });

    it('links a bare URL, with a safe scheme', () => {
      const { container } = render(<Markdown>{'see https://example.com/rules'}</Markdown>);
      expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/rules');
    });
  });

  describe('what it refuses to do', () => {
    it('shows raw HTML as text and creates no elements from it', () => {
      const { container } = render(
        <Markdown>{'<script>window.__pwned = true</script>\n\n<img src=x onerror="window.__pwned=true">'}</Markdown>
      );
      expect(container.querySelector('script')).toBeNull();
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain('<script>');
      expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    });

    it('strips javascript: and data: links to nothing', () => {
      const { container } = render(
        <Markdown>{'[a](javascript:alert(1))\n\n[b](data:text/html;base64,PHNjcmlwdD4=)\n\n[c](https://ok.example)'}</Markdown>
      );
      const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
      expect(hrefs).toEqual(['', '', 'https://ok.example']);
    });

    it('does not let an autolink smuggle a scheme in', () => {
      // GFM autolinks only recognise http, https, mailto and www. Nothing else
      // becomes a link at all.
      const { container } = render(<Markdown>{'try javascript:alert(1) or ftp://x.example'}</Markdown>);
      const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
      expect(hrefs.some((h) => h.startsWith('javascript:'))).toBe(false);
    });

    it('drops an onerror on an image written in Markdown', () => {
      const { container } = render(<Markdown>{'![x](/api/assets/maps/abc "onerror=alert(1)")'}</Markdown>);
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('onerror')).toBeNull();
    });
  });

  describe('images', () => {
    // An image on another host makes every reader's browser fetch it, which
    // tells that host who opened the document and when. Only this instance's
    // own images are shown; the rest fall back to their alt text.
    it('shows an image served by this instance', () => {
      const { container } = render(<Markdown>{'![the dungeon](/api/assets/maps/abc)'}</Markdown>);
      const img = container.querySelector('img');
      expect(img?.getAttribute('src')).toBe('/api/assets/maps/abc');
      expect(img?.getAttribute('alt')).toBe('the dungeon');
    });

    it('shows an image given with this instance\'s full address', () => {
      const { container } = render(
        <Markdown>{`![map](${window.location.origin}/api/assets/maps/abc)`}</Markdown>
      );
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        `${window.location.origin}/api/assets/maps/abc`
      );
    });

    it('does not load an image from another host, and shows its alt text instead', () => {
      const { container } = render(<Markdown>{'![tracker](https://evil.example/pixel.png)'}</Markdown>);
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain('tracker');
    });

    it('treats a protocol-relative address as another host', () => {
      const { container } = render(<Markdown>{'![x](//evil.example/pixel.png)'}</Markdown>);
      expect(container.querySelector('img')).toBeNull();
    });

    it('drops an image with no usable address without throwing', () => {
      const { container } = render(<Markdown>{'![empty]()'}</Markdown>);
      expect(container.querySelector('img')).toBeNull();
    });
  });
});
