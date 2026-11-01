
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

    // Get published articles
    if (url.pathname === "/api/articles") {
      const { results } = await env.DB.prepare(
        `SELECT * FROM articles
         WHERE status = 'published'
         ORDER BY created_at DESC
         LIMIT 50`
      ).all();

      return Response.json(results);
    }

    // Secure manual collection endpoint
    if (url.pathname === "/api/collect") {
      if (request.method !== "POST") {
        return Response.json(
          { success: false, message: "POST required" },
          { status: 405 }
        );
      }

      const token = request.headers.get("X-Collect-Secret");

      if (!env.COLLECT_SECRET || token !== env.COLLECT_SECRET) {
        return Response.json(
          { success: false, message: "Unauthorized" },
          { status: 401 }
        );
      }

      await collectArticles(env);

      return Response.json({
        success: true,
        message: "RSS collection completed"
      });
    }

    // Serve the website
    return env.ASSETS.fetch(request);
  },

  // Automatic collection every two hours
  async scheduled(event, env, ctx) {
    ctx.waitUntil(collectArticles(env));
  }
};

async function collectArticles(env) {
  for (const feed of FEEDS) {
    try {
      const response = await fetch(feed.url);

      if (!response.ok) {
        console.error("Feed failed:", feed.name, response.status);
        continue;
      }

      const xml = await response.text();
      const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];

      for (const item of items.slice(0, 15)) {
        const title = getTag(item, "title");
        const link = getTag(item, "link");
        const description = getTag(item, "description");

        if (!title || !link) continue;

        // Prevent duplicate articles
        const existing = await env.DB.prepare(
          "SELECT id FROM articles WHERE url = ? LIMIT 1"
        ).bind(link).first();

        if (existing) continue;

        // Save article as published
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
      console.error("Feed failed:", feed.name, error);
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
