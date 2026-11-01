
const FEEDS = [
  {
    name: "Steam",
    category: "Gaming News",
    url: "https://store.steampowered.com/feeds/news.xml"
  },
  {
    name: "Gematsu",
    category: "Gaming News",
    url: "https://www.gematsu.com/feed"
  },
  {
    name: "PlayStation Blog",
    category: "Gaming News",
    url: "https://blog.playstation.com/feed/"
  }
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/articles") {
      const { results } = await env.DB.prepare(
        `SELECT * FROM articles
         WHERE status = 'published'
         ORDER BY created_at DESC
         LIMIT 50`
      ).all();

      return Response.json(results);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(collectArticles(env));
  }
};

async function collectArticles(env) {
  for (const feed of FEEDS) {
    try {
      const response = await fetch(feed.url, {
        headers: {
          "User-Agent": "JeezyDropz Content Collector/1.0"
        }
      });

      if (!response.ok) continue;

      const xml = await response.text();
      const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];

      for (const item of items.slice(0, 15)) {
        const title = getTag(item, "title");
        const link = getTag(item, "link");
        const description = getTag(item, "description");

        if (!title || !link) continue;

        const existing = await env.DB.prepare(
          "SELECT id FROM articles WHERE url = ? LIMIT 1"
        ).bind(link).first();

        if (existing) continue;

        await env.DB.prepare(
          `INSERT INTO articles
          (title, summary, content, url, source_name, category, status, published_at)
          VALUES (?, ?, ?, ?, ?, ?, 'published', CURRENT_TIMESTAMP)`
        ).bind(
          title,
          description,
          description,
          link,
          feed.name,
          feed.category
        ).run();
      }
    } catch (error) {
      console.error(`Feed failed: ${feed.name}`, error);
    }
  }
}

function getTag(xml, tag) {
  const match = xml.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i")
  );

  if (!match) return "";

  return match[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
