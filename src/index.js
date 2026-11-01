
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API: Get published articles
    if (url.pathname === "/api/articles") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM articles WHERE status = 'published' ORDER BY created_at DESC LIMIT 50"
      ).all();

      return Response.json(results);
    }

    // Serve the website
    return env.ASSETS.fetch(request);
  },

  // Scheduled content updates
  async scheduled(event, env, ctx) {
    // Content collection will be added in the next stage.
  }
};
