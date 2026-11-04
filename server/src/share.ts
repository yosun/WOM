// What a link to WOM shows when it is pasted into a chat or a post. The page is the same app as ever. The tags here are for
// the crawlers that read a page and never run its script. web/index.html holds the site's own tags and the generic preview
// picture. A shared memory replaces the title, the line about it and the picture with its own. Every /u/ page is kept out of
// search results. A world nobody may look at, or none at all, keeps the site's tags and tells nothing about the world.

const SITE = 'World of a Memory';
const FALLBACK = 'Step inside a photo: WOM rebuilds a single image as an explorable 3D world.';

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

export interface Preview {
  /** This page's own address, with the origin. It is the canonical link and og:url. */
  url: string;
  /** The memory's title. Without one the page keeps the site's own title, line and picture. */
  title?: string;
  /** The line about the memory. */
  description?: string;
  /** The memory's picture, with the origin. Without one the page keeps the site's picture. */
  image?: { url: string; width: number; height: number; alt: string };
}

/** Puts `tag` in place of the template's own tag for this key, or before </head> when there is none, so a page never has two. */
function setTag(html: string, existing: RegExp, tag: string): string {
  return existing.test(html) ? html.replace(existing, () => tag) : html.replace('</head>', () => `    ${tag}\n  </head>`);
}

function setMeta(html: string, attr: 'name' | 'property', key: string, value: string): string {
  return setTag(html, new RegExp(`<meta ${attr}="${key}"[^>]*>`), `<meta ${attr}="${key}" content="${escapeHtml(value)}" />`);
}

/** `template` (the built index.html) with this page's tags in it. Function replacers keep a `$` in a title from being read as a pattern. */
export function withPreview(template: string, p: Preview): string {
  // Worlds are shared by link, not listed, so search engines are told to leave every /u/ page out.
  let html = setMeta(template, 'name', 'robots', 'noindex');
  html = setTag(html, /<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${escapeHtml(p.url)}" />`);
  html = setMeta(html, 'property', 'og:url', p.url);
  if (!p.title) return html;

  const title = `${p.title.replace(/\s+/g, ' ').trim()} · ${SITE}`;
  const description = (p.description || FALLBACK).replace(/\s+/g, ' ').trim().slice(0, 200);
  html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title>`);
  html = setMeta(html, 'name', 'description', description);
  html = setMeta(html, 'property', 'og:title', title);
  html = setMeta(html, 'property', 'og:description', description);
  html = setMeta(html, 'name', 'twitter:title', title);
  html = setMeta(html, 'name', 'twitter:description', description);
  if (p.image) {
    html = setMeta(html, 'property', 'og:image', p.image.url);
    html = setMeta(html, 'property', 'og:image:width', String(p.image.width));
    html = setMeta(html, 'property', 'og:image:height', String(p.image.height));
    html = setMeta(html, 'property', 'og:image:alt', p.image.alt);
    html = setMeta(html, 'name', 'twitter:image', p.image.url);
    html = setMeta(html, 'name', 'twitter:image:alt', p.image.alt);
  }
  return html;
}
