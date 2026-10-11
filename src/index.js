const SITE_URL = "https://yourtechsite.pages.dev"; // change to your real domain

// ---------- Helpers ----------

async function postToTelegram(env, video) {
  // Only title + website link, as requested
  const caption = `${video.title}\n\n${SITE_URL}/video/${video.video_id}`;

  const photoUrl = `https://i.ytimg.com/vi/${video.video_id}/hqdefault.jpg`;

  const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendPhoto`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TG_CHANNEL_ID,
      photo: photoUrl,
      caption,
    }),
  });
}

async function isEmbeddable(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://youtu.be/${videoId}&format=json`
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchFromRSS(channelId) {
  const res = await fetch(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
  );
  if (!res.ok) return [];
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];

  return entries
    .map((e) => {
      const block = e[1];
      const videoId = block.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1];
      const title = block.match(/<media:title>(.*?)<\/media:title>/)?.[1]
        || block.match(/<title>(.*?)<\/title>/)?.[1];
      const published = block.match(/<published>(.*?)<\/published>/)?.[1];
      return videoId
        ? {
            videoId,
            title,
            published,
            thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          }
        : null;
    })
    .filter(Boolean);
}

// ---------- Cron job: fetch + store ----------

async function fetchAndStoreVideos(env) {
  const { results: channels } = await env.DB.prepare(
    "SELECT channel_id, name FROM channels WHERE active = 1"
  ).all();

  for (const channel of channels) {
    const videos = await fetchFromRSS(channel.channel_id);

    for (const v of videos) {
      const exists = await env.DB.prepare(
        "SELECT 1 FROM videos WHERE video_id = ?"
      ).bind(v.videoId).first();
      if (exists) continue;

      const embeddable = await isEmbeddable(v.videoId);
      if (!embeddable) continue;

      await env.DB.prepare(
        `INSERT INTO videos (video_id, title, thumbnail, channel_title, published_at)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(v.videoId, v.title, v.thumbnail, channel.name, v.published)
        .run();

      await postToTelegram(env, {
        video_id: v.videoId,
        title: v.title,
      });
    }
  }

  // cleanup old entries (90+ days)
  await env.DB.prepare(
    "DELETE FROM videos WHERE created_at < datetime('now', '-90 days')"
  ).run();
}

// ---------- HTTP routes ----------

async function handleVideos(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(request.url);
  let response = await cache.match(cacheKey);
  if (response) return response;

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = 20;
  const offset = (page - 1) * limit;

  const { results } = await env.DB.prepare(
    "SELECT video_id, title, thumbnail, channel_title, published_at FROM videos ORDER BY published_at DESC LIMIT ? OFFSET ?"
  )
    .bind(limit, offset)
    .all();

  response = new Response(JSON.stringify(results), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "max-age=1800",
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleSitemap(env) {
  const { results } = await env.DB.prepare(
    "SELECT video_id, created_at FROM videos"
  ).all();
  const urls = results
    .map(
      (v) =>
        `<url><loc>${SITE_URL}/video/${v.video_id}</loc><lastmod>${v.created_at}</lastmod></url>`
    )
    .join("");
  return new Response(
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
    { headers: { "Content-Type": "application/xml" } }
  );
}

// ---------- Entry points ----------

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndStoreVideos(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/videos") return handleVideos(request, env, ctx);
    if (url.pathname === "/sitemap.xml") return handleSitemap(env);
    if (url.pathname === "/run-now") {
      await fetchAndStoreVideos(env);
      return new Response("Fetched", {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
