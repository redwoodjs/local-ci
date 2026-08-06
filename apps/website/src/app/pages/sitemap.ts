import { allPosts } from "content-collections";

// Canonical origin for absolute URLs in the sitemap.
// Per sitemaps.org the <loc> must be a fully-qualified URL.
const ORIGIN = "https://local-ci.dev";

// Static routes that are always part of the sitemap.
// Blog posts are enumerated dynamically from content-collections.
const staticRoutes: { path: string; priority?: string }[] = [
  { path: "/", priority: "1.0" },
  { path: "/compatibility", priority: "0.8" },
  { path: "/blog", priority: "0.8" },
];

// Markdown docs copied from the CLI by scripts/copy-docs.mjs.
// Keep this list in sync with that script.
const docRoutes = [
  "/docs/README.md",
  "/docs/compatibility.md",
  "/docs/runner-image.md",
  "/docs/SKILL.md",
];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function urlEntry({
  loc,
  lastmod,
  priority,
}: {
  loc: string;
  lastmod?: string;
  priority?: string;
}): string {
  const parts = [`  <url>`, `    <loc>${escapeXml(loc)}</loc>`];
  if (lastmod) {
    parts.push(`    <lastmod>${lastmod}</lastmod>`);
  }
  if (priority) {
    parts.push(`    <priority>${priority}</priority>`);
  }
  parts.push(`  </url>`);
  return parts.join("\n");
}

function toIsoDate(d: unknown): string | undefined {
  if (!d) {
    return undefined;
  }
  const date = d instanceof Date ? d : new Date(d as string);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString().slice(0, 10);
}

export function sitemap(): Response {
  const entries: string[] = [];

  for (const { path, priority } of staticRoutes) {
    entries.push(urlEntry({ loc: `${ORIGIN}${path}`, priority }));
  }

  for (const path of docRoutes) {
    entries.push(urlEntry({ loc: `${ORIGIN}${path}`, priority: "0.7" }));
  }

  const posts = [...allPosts]
    .filter((p) => !p.protected)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  for (const post of posts) {
    const slug = post._meta.path.replace(/\.md$/, "");
    entries.push(
      urlEntry({
        loc: `${ORIGIN}/blog/${slug}`,
        lastmod: toIsoDate(post.date),
        priority: "0.6",
      }),
    );
  }

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/0.9">\n` +
    entries.join("\n") +
    `\n</urlset>\n`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
