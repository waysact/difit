import { describe, expect, it } from 'vitest';

import { resolvePublicUrl } from './public-url.js';

describe('resolvePublicUrl', () => {
  it('returns the fallback when no template is given', () => {
    expect(resolvePublicUrl(undefined, 4966, 'http://localhost:4966')).toBe(
      'http://localhost:4966',
    );
  });

  it('substitutes the bound port', () => {
    expect(
      resolvePublicUrl('https://difit-{port}.inst.eg.localhost', 4972, 'http://localhost:4972'),
    ).toBe('https://difit-4972.inst.eg.localhost');
  });

  it('substitutes every occurrence', () => {
    expect(resolvePublicUrl('https://a-{port}.b/{port}', 1, 'x')).toBe('https://a-1.b/1');
  });

  it('leaves a template without a placeholder unchanged', () => {
    expect(resolvePublicUrl('https://review.example', 4966, 'x')).toBe('https://review.example');
  });

  it('does not treat other braces as placeholders', () => {
    expect(resolvePublicUrl('https://a/{host}', 4966, 'x')).toBe('https://a/{host}');
  });

  it('treats an empty-string template as absent and returns the fallback', () => {
    expect(resolvePublicUrl('', 4966, 'http://localhost:4966')).toBe('http://localhost:4966');
  });
});
