#!/usr/bin/env node
// Regenerates the marked blog and worklog sections of README.md from the
// feeds on zander.wtf. Run with `node scripts/update-readme.mjs`; the
// workflow in .github/workflows/update-readme.yml runs it weekly.
//
// Both lists come from https://zander.wtf/blog.rss.xml, which carries every
// entry in the site's `blog` collection. Each item is tagged <category>post</category>
// or <category>worklog</category>, which is what separates the two lists here.

import { readFile, writeFile } from 'node:fs/promises';

// FEED_URL lets me point at a local build (file:// works) to test a feed
// change before it has deployed.
const FEED = process.env.FEED_URL ?? 'https://zander.wtf/blog.rss.xml';
const README = new URL('../README.md', import.meta.url);

const SECTIONS = [
  { marker: 'BLOG-POST-LIST', category: 'post', count: 6 },
  { marker: 'WORKLOG-LIST', category: 'worklog', count: 6 },
];

/** Decode the XML entities @astrojs/rss emits. */
const decode = (str) =>
  str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');

const tag = (item, name) => {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return match ? decode(match[1]).trim() : '';
};

/**
 * Markdown link text is not a plain string: an unescaped `[` or `]` in a title
 * would break the link, and a bare `*` or `_` would start emphasis.
 */
const escapeMd = (str) => str.replace(/([\\`*_[\]<>])/g, '\\$1');

const parseFeed = (xml) =>
  [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => ({
    title: tag(item, 'title'),
    link: tag(item, 'link'),
    description: tag(item, 'description'),
    categories: [...item.matchAll(/<category>([\s\S]*?)<\/category>/g)].map(([, c]) =>
      decode(c).trim(),
    ),
  }));

/**
 * The feed is already sorted newest-first by the site, so no re-sorting here —
 * that also keeps the output stable when two entries share a date.
 */
const render = (items, { category, count }) =>
  items
    .filter((item) => item.categories.includes(category) && item.title && item.link)
    .slice(0, count)
    .map(({ title, link, description }) => {
      // Subtitles are inconsistent about trailing full stops; drop them so the
      // list reads evenly. Capitalisation is left exactly as authored, since
      // lower-casing would mangle "I extracted…" and any leading proper noun.
      const summary = description.replace(/\s+/g, ' ').replace(/\.$/, '');
      const hook = summary ? ` — ${summary}` : '';
      return `- [${escapeMd(title)}](${link})${hook}`;
    })
    .join('\n');

const replaceSection = (readme, marker, body) => {
  const start = `<!-- ${marker}:START -->`;
  const end = `<!-- ${marker}:END -->`;
  const pattern = new RegExp(`(${start})[\\s\\S]*?(${end})`);
  if (!pattern.test(readme)) {
    throw new Error(`Could not find the ${marker} markers in README.md`);
  }
  return readme.replace(pattern, `$1\n${body}\n$2`);
};

// Node's fetch has no file:// support, so read those straight off disk.
const fetchFeed = async (url) => {
  if (url.startsWith('file://')) return readFile(new URL(url), 'utf8');

  const response = await fetch(url, {
    headers: { 'user-agent': 'mrmartineau-readme-updater' },
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }
  return response.text();
};

const items = parseFeed(await fetchFeed(FEED));
if (items.length === 0) {
  throw new Error('Parsed zero items from the feed — refusing to blank the README');
}

const original = await readFile(README, 'utf8');
let updated = original;

for (const section of SECTIONS) {
  const body = render(items, section);
  // A feed change that empties a section is far more likely to be a parsing
  // bug than a genuine result, so bail out rather than commit an empty list.
  if (!body) {
    throw new Error(`No items matched category "${section.category}"`);
  }
  updated = replaceSection(updated, section.marker, body);
}

if (updated === original) {
  console.log('README is already up to date.');
  process.exit(0);
}

await writeFile(README, updated);
console.log('README updated.');
