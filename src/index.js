
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

    // Return published articles
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

      const result = await collectArticles(env);

      return Response.json({
        success: true,
        message: "RSS collection completed",
        ...result
      });
    }

    // Serve the existing website
    return env.ASSETS.fetch(request);
  },

  // Automatically collect articles every two hours
  async scheduled(event, env, ctx) {
    ctx.waitUntil(collectArticles(env));
  }
};

async function collectArticles(env) {
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const feed of FEEDS) {
    try {
      const response = await fetch(feed.url, {
        headers: {
          "User-Agent": "JeezyDropz News Collector/1.0"
        }
      });

      if (!response.ok) {
        console.error(
          "Feed request failed:",
          feed.name,
          response.status
        );
        errors++;
        continue;
      }

      const xml = await response.text();

      // Support RSS items and Atom entries
      const items = [
        ...(xml.match(/<item\b[\s\S]*?<\/item>/gi) || []),
        ...(xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [])
      ];

      for (const item of items.slice(0, 20)) {
        const title = cleanText(getTag(item, "title"));

        let link = cleanText(getTag(item, "link"));

        // Atom feeds commonly store links in href attributes
        if (!link) {
          const linkMatch = item.match(
            /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i
          );

          if (linkMatch) link = linkMatch[1];
        }

        if (!title || !link) {
          skipped++;
          continue;
        }

        link = safeHttpURL(link);

        if (!link) {
          skipped++;
          continue;
        }

        // Prevent duplicate articles
        const existing = await env.DB.prepare(
          "SELECT id FROM articles WHERE url = ? LIMIT 1"
        ).bind(link).first();

        if (existing) {
          skipped++;
          continue;
        }

        // Extract article summary
        const description =
          getTag(item, "description") ||
          getTag(item, "summary") ||
          getTag(item, "encoded") ||
          getTag(item, "content");

        const summary = cleanText(description).slice(0, 1500);

        // Extract an image when the feed provides one
        const imageUrl = extractImage(item);

        // Extract the original publication date
        const originalDate =
          getTag(item, "pubDate") ||
          getTag(item, "published") ||
          getTag(item, "updated") ||
          getTag(item, "date");

        const publishedAt = formatDate(originalDate);

        await env.DB.prepare(
          `INSERT INTO articles
          (
            title,
            summary,
            content,
            url,
            image_url,
            source_name,
            category,
            status,
            published_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?)`
        ).bind(
          title,
          summary,
          summary,
          link,
          imageUrl,
          feed.name,
          feed.category,
          publishedAt
        ).run();

        imported++;
      }
    } catch (error) {
      console.error("Feed failed:", feed.name, error);
      errors++;
    }
  }

  return { imported, skipped, errors };
}

// Extract text from an XML element
function getTag(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const match = xml.match(
    new RegExp(
      `<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}\\s*>`,
      "i"
    )
  );

  return match ? match[1] : "";
}

// Extract image URLs from RSS or Atom content
function extractImage(item) {
  const imageTags = [
    /<media:content\b[^>]*url=["']([^"']+)["']/i,
    /<media:thumbnail\b[^>]*url=["']([^"']+)["']/i,
    /<enclosure\b[^>]*url=["']([^"']+)["']/i,
    /<image>\s*<url>([\s\S]*?)<\/url>/i
  ];

  for (const pattern of imageTags) {
    const match = item.match(pattern);

    if (match) {
      const url = safeHttpURL(cleanText(match[1]));
      if (url) return url;
    }
  }

  // Look for an image embedded in article HTML
  const html = getTag(item, "encoded") ||
               getTag(item, "description") ||
               getTag(item, "content") ||
               getTag(item, "summary");

  const imageMatch = html.match(
    /<img\b[^>]*src=["']([^"']+)["']/i
  );

  if (imageMatch) {
    return safeHttpURL(decodeEntities(imageMatch[1]));
  }

  return null;
}

// Remove HTML and decode common XML/HTML entities
function cleanText(value) {
  return decodeEntities(
    String(value || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16))
    );
}

// Only accept HTTP and HTTPS URLs
function safeHttpURL(value) {
  try {
    const url = new URL(value);

    return ["http:", "https:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

// Convert the original feed date into a database-friendly date
function formatDate(value) {
  if (!value) return new Date().toISOString();

  const timestamp = Date.parse(cleanText(value));

  return Number.isNaN(timestamp)
    ? new Date().toISOString()
    : new Date(timestamp).toISOString();
}
