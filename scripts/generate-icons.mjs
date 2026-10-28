import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const iconDirectory = new URL('../public/icons/', import.meta.url);
const svg = await readFile(new URL('oddy.svg', iconDirectory), 'utf8');
const checkOnly = process.argv.includes('--check');
const sizes = [16, 32, 48, 128, 256];

for (const size of sizes) {
  const path = new URL(`${size}.png`, iconDirectory);
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  if (checkOnly) {
    const current = await readFile(path);
    if (!current.equals(png)) {
      throw new Error(`${fileURLToPath(path)} is out of date. Run npm run icons.`);
    }
    console.log(`Verified ${size}×${size}`);
  } else {
    await writeFile(path, png);
    console.log(`Generated ${fileURLToPath(path)}`);
  }
}
