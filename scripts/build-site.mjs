import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { 'out-dir': { type: 'string' } } });
const output = resolve(values['out-dir'] ?? resolve(root, '.output/site'));
const pages = [
  {
    source: 'site-index.md',
    path: '',
    title: 'Oddy — Your Dataverse Raven',
    home: './',
    privacy: './privacy/'
  },
  {
    source: 'privacy.md',
    path: 'privacy',
    title: 'Oddy Privacy Policy',
    home: '../',
    privacy: './'
  }
];
const styles = `
:root { color-scheme: light; font-family: "Segoe UI", Helvetica, sans-serif; color: #202c44; background: #f4f7fa; }
* { box-sizing: border-box; }
body { margin: 0; font-size: 17px; line-height: 1.7; }
header, main, footer { width: min(100% - 40px, 850px); margin-inline: auto; }
header { padding-block: 28px 20px; border-bottom: 1px solid #d6dee8; }
nav { display: flex; flex-wrap: wrap; gap: 24px; align-items: center; }
nav a:first-child { font-size: 23px; font-weight: 700; text-decoration: none; }
main { padding-block: 24px 48px; overflow-wrap: anywhere; }
h1, h2 { line-height: 1.25; letter-spacing: -0.02em; }
h1 { font-size: clamp(30px, 5vw, 42px); margin-block: 10px 24px; }
h2 { font-size: 24px; margin-block: 36px 16px; }
p, ul { margin-block: 16px; }
li { margin-block: 10px; }
a { color: #126758; text-underline-offset: 3px; }
a:hover { color: #174a42; }
a:focus-visible { outline: 3px solid #126758; outline-offset: 4px; }
code { padding: 2px 5px; border-radius: 3px; background: #e8edf3; }
footer { padding-block: 22px 32px; border-top: 1px solid #d6dee8; font-size: 14px; color: #53657a; }
`;

for (const page of pages) {
  const markdown = await readFile(resolve(root, 'docs', page.source), 'utf8');
  const body = renderToStaticMarkup(createElement(Markdown, { children: markdown }));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${page.title}</title>
<style>${styles}</style>
</head>
<body>
<header><nav aria-label="Main navigation"><a href="${page.home}">Oddy</a><a href="${page.privacy}">Privacy policy</a><a href="https://github.com/ksavvopoulos/oddy">Project</a></nav></header>
<main>${body}</main>
<footer>Oddy project · No added analytics or advertising on this site. Hosting is provided by GitHub Pages.</footer>
</body>
</html>
`;
  const directory = resolve(output, page.path);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'index.html'), html);
}
await writeFile(resolve(output, '.nojekyll'), '');
console.log(`Built static policy site at ${output}`);
