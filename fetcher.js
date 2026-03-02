const axios = require("axios");
const cheerio = require("cheerio");
const TurndownService = require("turndown");

const HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

/**
 * 从 HTML script 标签中提取发布时间
 */
function extractPublishTime(html) {
    const m1 = html.match(/create_time\s*:\s*JsDecode\('([^']+)'\)/);
    if (m1) {
        const val = m1[1];
        const ts = parseInt(val, 10);
        if (!isNaN(ts) && ts > 0) {
            return formatTimestamp(ts);
        }
        return val;
    }

    const m2 = html.match(/create_time\s*:\s*'(\d+)'/);
    if (m2) {
        const ts = parseInt(m2[1], 10);
        return formatTimestamp(ts);
    }
    return "";
}

/**
 * Unix timestamp (秒) -> "YYYY-MM-DD HH:mm:ss" (Asia/Shanghai)
 */
function formatTimestamp(ts) {
    const d = new Date(ts * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const offset = 8 * 60;
    const local = new Date(d.getTime() + offset * 60 * 1000);
    return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
}

/**
 * 提取文章元数据: 标题、作者、发布时间
 */
function extractMetadata($, html) {
    return {
        title: $("#activity-name").text().trim(),
        author: $("#js_name").text().trim(),
        publishTime: extractPublishTime(html),
    };
}

/**
 * 预处理正文 DOM：修复图片、处理代码块、移除噪声元素
 */
function processContent($, contentEl) {
    // 1) 图片: data-src -> src (微信懒加载)
    contentEl.find("img").each((_, img) => {
        const dataSrc = $(img).attr("data-src");
        if (dataSrc) $(img).attr("src", dataSrc);
    });

    // 2) 代码块: 提取 code-snippet__fix 内容，替换为占位符
    const codeBlocks = [];
    contentEl.find(".code-snippet__fix").each((_, el) => {
        $(el).find(".code-snippet__line-index").remove();
        const lang = $(el).find("pre[data-lang]").attr("data-lang") || "";

        const lines = [];
        $(el)
            .find("code")
            .each((_, codeLine) => {
                const text = $(codeLine).text();
                if (/^[ce]?ounter\(line/.test(text)) return;
                lines.push(text);
            });
        if (lines.length === 0) lines.push($(el).text());

        const placeholder = `CODEBLOCK-PLACEHOLDER-${codeBlocks.length}`;
        codeBlocks.push({ lang, code: lines.join("\n") });
        $(el).replaceWith(`<p>${placeholder}</p>`);
    });

    // 3) 移除噪声元素
    contentEl.find("script, style, .qr_code_pc, .reward_area").remove();

    return { contentHtml: contentEl.html(), codeBlocks };
}

/**
 * HTML -> Markdown，还原代码块，清理格式
 */
function convertToMarkdown(contentHtml, codeBlocks) {
    const turndown = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        bulletListMarker: "-",
    });
    turndown.addRule("linebreak", {
        filter: "br",
        replacement: () => "\n",
    });

    let md = turndown.turndown(contentHtml);

    // 还原代码块占位符
    codeBlocks.forEach((block, i) => {
        const placeholder = `CODEBLOCK-PLACEHOLDER-${i}`;
        const fenced = `\n\`\`\`${block.lang}\n${block.code}\n\`\`\`\n`;
        md = md.replace(placeholder, fenced);
    });

    // 清理 &nbsp; 残留
    md = md.replace(/\u00a0/g, " ");
    // 清理多余空行
    md = md.replace(/\n{4,}/g, "\n\n\n");
    // 清理行尾多余空格
    md = md.replace(/[ \t]+$/gm, "");

    return md;
}

/**
 * 拼接最终 Markdown 文件内容
 */
function buildMarkdown({ title, author, publishTime, sourceUrl }, bodyMd) {
    const header = [`# ${title}`, ""];
    if (author) header.push(`> 公众号: ${author}`);
    if (publishTime) header.push(`> 发布时间: ${publishTime}`);
    if (sourceUrl) header.push(`> 原文链接: ${sourceUrl}`);
    if (author || publishTime || sourceUrl) header.push("");
    header.push("---", "");
    return header.join("\n") + bodyMd;
}

/**
 * 抓取微信文章并转换为 Markdown
 * @param {string} url - 微信文章 URL
 * @returns {Promise<{title: string, author: string, publishTime: string, markdown: string, error: null} | {error: string}>}
 */
async function fetchArticle(url) {
    try {
        // URL 格式校验
        if (!url.startsWith("https://mp.weixin.qq.com/")) {
            return { error: "请输入有效的微信文章 URL (https://mp.weixin.qq.com/...)" };
        }

        const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 30000 });
        const $ = cheerio.load(html);

        // 提取元数据
        const meta = extractMetadata($, html);
        if (!meta.title) {
            return { error: "未能提取到文章标题，可能触发了验证码" };
        }
        meta.sourceUrl = url;

        // 处理正文
        const { contentHtml, codeBlocks } = processContent($, $("#js_content"));
        if (!contentHtml) {
            return { error: "未能提取到正文内容" };
        }

        // 转 Markdown
        const bodyMd = convertToMarkdown(contentHtml, codeBlocks);
        const markdown = buildMarkdown(meta, bodyMd);

        return {
            title: meta.title,
            author: meta.author,
            publishTime: meta.publishTime,
            markdown,
            error: null,
        };
    } catch (err) {
        if (err.response?.status === 403 || err.response?.status === 412) {
            return { error: "微信反爬拦截，请稍后重试或更换 IP" };
        } else if (err.code === "ECONNABORTED") {
            return { error: "请求超时，请检查网络连接" };
        } else {
            return { error: `抓取失败: ${err.message}` };
        }
    }
}

module.exports = { fetchArticle };
