const { fetchArticle } = require("./fetcher");
const core = require("@actions/core");
const github = require("@actions/github");

/**
 * 从文本中提取所有微信文章链接
 */
function extractWechatUrls(text) {
    // 匹配两种格式：
    // 1. https://mp.weixin.qq.com/s/xxxxx
    // 2. https://mp.weixin.qq.com/s?xxx=xxx
    const regex = /https:\/\/mp\.weixin\.qq\.com\/s[/?][^\s)]+/g;
    const matches = text.match(regex) || [];
    return [...new Set(matches)]; // 去重
}

/**
 * 确保 label 存在，如果不存在则创建
 */
async function ensureLabel(octokit, owner, repo, name, color, description) {
    try {
        await octokit.rest.issues.getLabel({
            owner,
            repo,
            name,
        });
    } catch (error) {
        if (error.status === 404) {
            // Label 不存在，创建它
            await octokit.rest.issues.createLabel({
                owner,
                repo,
                name,
                color,
                description,
            });
            console.log(`Created label: ${name} (${color})`);
        }
    }
}

/**
 * 主函数
 */
async function run() {
    try {
        const token = process.env.GITHUB_TOKEN || core.getInput("github-token");
        const octokit = github.getOctokit(token);
        const context = github.context;

        // 检查是否是 issue 事件
        if (!context.payload.issue) {
            console.log("Not an issue event, skipping");
            return;
        }

        const issueNumber = context.payload.issue.number;
        const issueBody = context.payload.issue.body || "";

        // 提取微信链接
        const urls = extractWechatUrls(issueBody);
        if (urls.length === 0) {
            console.log("No WeChat article URLs found in issue body");
            return;
        }

        console.log(`Found ${urls.length} WeChat article URL(s)`);

        // 确保所需的 labels 存在
        await ensureLabel(octokit, context.repo.owner, context.repo.repo, "spying", "fbca04", "正在抓取微信文章");
        await ensureLabel(octokit, context.repo.owner, context.repo.repo, "success", "0e8a16", "文章抓取成功");
        await ensureLabel(octokit, context.repo.owner, context.repo.repo, "failed", "d73a4a", "文章抓取失败");

        // 添加 "spying" 标签，表示开始抓取
        await octokit.rest.issues.addLabels({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: issueNumber,
            labels: ["spying"],
        });
        console.log("Added 'spying' label");

        let hasError = false;
        const articleTitles = [];

        // 逐个处理链接并回复
        for (const url of urls) {
            console.log(`Processing: ${url}`);
            const result = await fetchArticle(url);

            let commentBody;
            if (result.error) {
                commentBody = `❌ 抓取失败: ${result.error}\n\n原文链接: ${url}`;
                hasError = true;
            } else {
                commentBody = result.markdown;
                articleTitles.push(result.title);
            }

            // 发布评论
            await octokit.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: issueNumber,
                body: commentBody,
            });

            console.log(`Comment posted for: ${url}`);
        }

        // 移除 "spying" 标签
        await octokit.rest.issues.removeLabel({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: issueNumber,
            name: "spying",
        }).catch(() => {
            console.log("Failed to remove 'spying' label (may not exist)");
        });

        // 根据结果添加最终状态标签
        const finalLabel = hasError ? "failed" : "success";
        await octokit.rest.issues.addLabels({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: issueNumber,
            labels: [finalLabel],
        });
        console.log(`Added '${finalLabel}' label`);

        // 如果全部成功，更新 Issue 标题并关闭
        if (!hasError && articleTitles.length > 0) {
            let newTitle;
            if (articleTitles.length === 1) {
                // 单篇文章：直接使用文章标题
                newTitle = articleTitles[0];
            } else {
                // 多篇文章：显示第一篇 + 数量
                newTitle = `${articleTitles[0]} + ${articleTitles.length - 1}篇更多`;
            }

            // 更新 Issue 标题并关闭
            await octokit.rest.issues.update({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: issueNumber,
                title: newTitle,
                state: "closed",
            });
            console.log(`Updated issue title and closed: ${newTitle}`);
        }

        console.log("All articles processed");
    } catch (error) {
        // 如果发生异常，尝试添加 "failed" 标签
        try {
            const token = process.env.GITHUB_TOKEN || core.getInput("github-token");
            const octokit = github.getOctokit(token);
            const context = github.context;

            if (context.payload.issue) {
                await octokit.rest.issues.removeLabel({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    issue_number: context.payload.issue.number,
                    name: "spying",
                }).catch(() => {});

                await octokit.rest.issues.addLabels({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    issue_number: context.payload.issue.number,
                    labels: ["failed"],
                });
            }
        } catch (labelError) {
            console.error("Failed to update label on error:", labelError.message);
        }

        core.setFailed(`Action failed: ${error.message}`);
    }
}

run();
