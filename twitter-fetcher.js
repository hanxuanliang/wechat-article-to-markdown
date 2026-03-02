const axios = require("axios");

const FXTWITTER_API = "https://api.fxtwitter.com";
const HEADERS = { "User-Agent": "Mozilla/5.0" };

/**
 * 从 Twitter/X URL 中提取 username 和 tweet_id
 */
function parseTweetUrl(url) {
    const match = url.match(
        /https:\/\/(x\.com|twitter\.com)\/([a-zA-Z0-9_]{1,15})\/status\/(\d+)/
    );
    if (!match) return null;
    return { username: match[2], tweetId: match[3] };
}

/**
 * 格式化大数字: 1200 → 1.2K, 3500000 → 3.5M
 */
function formatNumber(n) {
    if (n == null) return "0";
    n = Number(n);
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
}

/**
 * 构建媒体 Markdown（图片 + 视频）
 */
function buildMediaMarkdown(media) {
    if (!media) return "";
    const parts = [];

    const allMedia = media.all || [];
    for (const item of allMedia) {
        if (item.type === "photo" && item.url) {
            parts.push(`![img](${item.url})`);
        }
    }

    const videos = media.videos || [];
    for (const video of videos) {
        const videoUrl = video.url || "";
        if (videoUrl) {
            parts.push(`[🎥 Video](${videoUrl})`);
        }
    }

    return parts.length > 0 ? "\n" + parts.join("\n\n") : "";
}

/**
 * 构建引用推文 Markdown
 */
function buildQuoteMarkdown(quote) {
    if (!quote) return "";
    const name = quote.author?.name || quote.author?.screen_name || "";
    const handle = quote.author?.screen_name || "";
    const text = quote.text || "";
    const lines = text.split("\n").map((line) => `> ${line}`);
    return `\n\n> **Quoted @${handle}${name ? ` (${name})` : ""}:**\n${lines.join("\n")}`;
}

/**
 * 构建 Article（长文）Markdown
 */
function buildArticleMarkdown(article, author) {
    const parts = [];
    const handle = author?.screen_name || "";

    parts.push(`# ${article.title || "Untitled Article"}`);
    parts.push("");
    if (handle) parts.push(`> By @${handle}`);
    if (article.created_at) parts.push(`> ${article.created_at}`);
    parts.push("");
    parts.push("---");
    parts.push("");

    // 从 content.blocks 拼接正文
    const blocks = article.content?.blocks || [];
    if (blocks.length > 0) {
        const fullText = blocks
            .map((b) => b.text || "")
            .filter(Boolean)
            .join("\n\n");
        parts.push(fullText);
    } else if (article.preview_text) {
        parts.push(article.preview_text);
    }

    // article 内的图片
    const cover = article.cover_media?.media_info?.original_img_url;
    if (cover) parts.push("", `![cover](${cover})`);
    for (const entity of article.media_entities || []) {
        const imgUrl = entity.media_info?.original_img_url;
        if (imgUrl) parts.push("", `![img](${imgUrl})`);
    }

    return parts.join("\n");
}

/**
 * 抓取 Twitter/X 推文并转换为 Markdown
 * @param {string} url - Twitter/X 推文 URL
 * @returns {Promise<{title: string, author: string, markdown: string, error: null} | {error: string}>}
 */
async function fetchTweet(url) {
    // URL 解析
    const parsed = parseTweetUrl(url);
    if (!parsed) {
        return { error: "请输入有效的 Twitter/X 链接" };
    }

    const { username, tweetId } = parsed;
    const apiUrl = `${FXTWITTER_API}/${username}/status/${tweetId}`;

    let data;
    try {
        const resp = await axios.get(apiUrl, { headers: HEADERS, timeout: 30000 });
        data = resp.data;
    } catch (err) {
        if (err.code === "ECONNABORTED") {
            return { error: "请求超时，请检查网络连接" };
        }
        if (err.response) {
            return { error: `FxTwitter API 错误: HTTP ${err.response.status}` };
        }
        return { error: `网络错误: ${err.message}` };
    }

    if (data.code !== 200 || !data.tweet) {
        return { error: `FxTwitter 返回错误: ${data.message || "Unknown"}` };
    }

    const tweet = data.tweet;
    const authorName = tweet.author?.name || username;
    const handle = tweet.author?.screen_name || username;
    const createdAt = tweet.created_at || "";

    // 如果是 Article（长文），走专用格式
    if (tweet.article) {
        const articleMd = buildArticleMarkdown(tweet.article, tweet.author);
        const stats = `\n---\n❤️ ${formatNumber(tweet.likes)}  🔁 ${formatNumber(tweet.retweets)}  👁 ${formatNumber(tweet.views)}\nSource: ${url}\nDate: ${createdAt}`;
        return {
            title: tweet.article.title || `@${handle} Article`,
            author: handle,
            markdown: articleMd + stats,
            error: null,
        };
    }

    // 普通推文
    const parts = [];
    parts.push(`# ${authorName} (@${handle})`);
    parts.push("");
    parts.push(tweet.text || "");

    // 引用推文
    if (tweet.quote) {
        parts.push(buildQuoteMarkdown(tweet.quote));
    }

    // 媒体
    const mediaMd = buildMediaMarkdown(tweet.media);
    if (mediaMd) parts.push(mediaMd);

    // 统计 + 来源
    parts.push("");
    parts.push("---");
    parts.push(`❤️ ${formatNumber(tweet.likes)}  🔁 ${formatNumber(tweet.retweets)}  👁 ${formatNumber(tweet.views)}`);
    parts.push(`Source: ${url}`);
    parts.push(`Date: ${createdAt}`);

    const markdown = parts.join("\n");
    const title = `@${handle}: ${(tweet.text || "").slice(0, 60)}${(tweet.text || "").length > 60 ? "..." : ""}`;

    return {
        title,
        author: handle,
        markdown,
        error: null,
    };
}

module.exports = { fetchTweet };
