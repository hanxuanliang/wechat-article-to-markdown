const { fetchArticle } = require("./fetcher");
const core = require("@actions/core");
const github = require("@actions/github");

/**
 * 从文本中提取所有微信文章链接
 */
function extractWechatUrls(text) {
    const regex = /https:\/\/mp\.weixin\.qq\.com\/s\/[^\s)]+/g;
    const matches = text.match(regex) || [];
    return [...new Set(matches)]; // 去重
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

        // 添加 "spying" 标签，表示开始抓取
        await octokit.rest.issues.addLabels({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: issueNumber,
            labels: ["spying"],
        });
        console.log("Added 'spying' label");

        let hasError = false;

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
