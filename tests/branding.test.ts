import { readFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it } from 'vitest';

const directory = new URL('../public/icons/', import.meta.url);
const svg = readFileSync(new URL('oddy.svg', directory), 'utf8');

describe('Oddy raven branding', () => {
  it('keeps the vector mascot accessible and self-contained', () => {
    expect(svg).toContain('Oddy — Dataverse Raven');
    expect(svg).toContain('front-facing');
    expect(svg).toContain('two expressive eyes');
    expect(svg).toContain('strong curved beak');
    expect(svg).toContain('shaggy throat feathers');
    expect(svg).toContain('aria-labelledby="title description"');
    expect(svg).toContain('viewBox="0 0 512 512"');
    expect(svg).not.toMatch(/<script\b|<image\b|crow|kraken|tentacle/i);
    for (const [, reference] of svg.matchAll(/href="([^"]+)"/g)) {
      expect(reference).toMatch(/^#/);
    }
  });

  it.each([16, 32, 48, 128, 256])(
    'keeps the %s-pixel PNG in sync with the vector mascot',
    (size) => {
      const png = readFileSync(new URL(`${size}.png`, directory));
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
      const expected = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
      expect(png.equals(expected), 'Run npm run icons after editing public/icons/oddy.svg.').toBe(
        true
      );
    }
  );
});
