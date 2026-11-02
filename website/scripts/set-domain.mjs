// Replaces the placeholder domain used for canonical, social-sharing and sitemap URLs.
// Usage: npm run set-domain -- https://www.yourgym.in
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OLD = 'https://www.fitnfine.example';
const raw = process.argv[2];
if (!raw || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(raw.replace(/\/$/, ''))) {
  console.error('Usage: npm run set-domain -- https://www.yourgym.in   (https, no path)');
  process.exit(1);
}
const next = raw.replace(/\/$/, '');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let changed = 0;
for (const file of ['index.html', 'robots.txt', 'sitemap.xml']) {
  const path = join(root, file);
  const text = readFileSync(path, 'utf8');
  const count = text.split(OLD).length - 1;
  if (count) writeFileSync(path, text.split(OLD).join(next));
  changed += count;
  console.log(`${file}: ${count} replaced`);
}
if (!changed) console.log(`No "${OLD}" left. Is the domain already set?`);
