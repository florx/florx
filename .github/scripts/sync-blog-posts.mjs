#!/usr/bin/env node
/**
 * Rewrites the post list in README.md from the blog's own Atom feed.
 *
 * The feed is the source of truth, not the blog repo: if a post is in the feed it is
 * published and its link resolves, which is the only thing this list has to get right.
 *
 * Run it anywhere - `node .github/scripts/sync-blog-posts.mjs` - and diff README.md.
 * It writes only when the rendered block actually differs, so the workflow can use
 * `git diff --quiet` to decide whether there is anything to commit.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * The real built file. `/blog/feed` is a Vercel rewrite alias and `blog.florxlabs.com/feed`
 * is a 308 to here - both work in a browser, both are one more thing to go wrong in a
 * script.
 */
const FEED_URL = 'https://florxlabs.com/blog/feed.xml';
const COUNT = 5;

const START = '<!-- BLOG-POST-LIST:START -->';
const END = '<!-- BLOG-POST-LIST:END -->';

const README = fileURLToPath(new URL('../../README.md', import.meta.url));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

const decode = (s) =>
  s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, name) => {
    if (name in ENTITIES) return ENTITIES[name];
    if (name[0] === '#') {
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });

/** Only the characters that would break out of `[text](url)`. */
const escapeLinkText = (s) => s.replace(/([\\[\]])/g, '\\$1');

async function fetchFeed(attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(FEED_URL, {
        cache: 'no-store',
        headers: { 'user-agent': 'florx-readme-sync', 'cache-control': 'no-cache' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      if (attempt === attempts) throw new Error(`Could not read ${FEED_URL}: ${error.message}`);
      console.warn(`Attempt ${attempt} failed (${error.message}), retrying…`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
}

/**
 * Hand-rolled rather than pulling in an XML parser. It holds because every <content> in the
 * feed is escaped HTML, so the only real <title> and <link> tags inside an <entry> are the
 * entry's own.
 */
function parse(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(([, entry]) => ({
      title: entry.match(/<title>([\s\S]*?)<\/title>/)?.[1],
      url: entry.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/)?.[1],
      published: entry.match(/<published>([^<]+)<\/published>/)?.[1],
    }))
    .filter((post) => post.title && post.url && post.published)
    .map((post) => ({ ...post, title: decode(post.title), url: decode(post.url) }))
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
}

const posts = parse(await fetchFeed());
if (posts.length === 0) throw new Error('The feed parsed to zero posts - refusing to empty the list.');

const list = posts
  .slice(0, COUNT)
  .map((post) => `- [${escapeLinkText(post.title)}](${post.url})`)
  .join('\n');

const readme = await readFile(README, 'utf8');
const block = new RegExp(`${START}[\\s\\S]*?${END}`);
if (!block.test(readme)) throw new Error(`README.md has no ${START} … ${END} block.`);

const updated = readme.replace(block, `${START}\n${list}\n${END}`);

if (updated === readme) {
  console.log('No change - the README already lists the newest posts.');
} else {
  await writeFile(README, updated);
  console.log(`Updated the README with the newest ${Math.min(COUNT, posts.length)} posts:\n${list}`);
}
