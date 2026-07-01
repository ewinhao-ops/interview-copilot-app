# 用 Codex 从 BOSS 前端获取简历并入库

本文档说明如何把 BOSS 招聘前端中可见的候选人简历，通过 Codex 整理成脱敏结构化数据，再写入面试工作台。

> 注意：仓库里只提供脱敏版 Codex Skill 和通用流程。真实账号、Cookie、候选人联系方式、飞书 token、数据库、录音、视频和截图都不要提交到 GitHub。

## 目录

- `codex-skills/boss-resume-ingest/SKILL.md`：脱敏版 Codex Skill，可复制到自己的 Codex skills 目录后按公司规则修改。
- `.env.example`：服务端环境变量模板。
- `server/routes.ts`、`server/repo/candidates.ts`：候选人入库接口和 SQLite 仓储逻辑。
- `scripts/upsert-boss-resume-to-feishu-library.mjs`：过渡期飞书写入脚本，优先使用 API 入库。

## 适用边界

这个流程适合“人工授权 + Codex 辅助整理”的单个候选人处理：

- HR 或招聘负责人已经能在 BOSS 网页端合法查看该候选人的会话或简历。
- Codex 只读取当前页面可见内容，不绕过登录、权限、风控、验证码或平台限制。
- 每次处理一个候选人，整理后由用户确认再写入系统。
- 输出进入私有部署的面试工作台，而不是公开文件。

不建议把它做成无监督批量爬虫。BOSS 页面结构、平台规则、账号权限和候选人隐私都需要人工把关。

## 第一步：安装或引用 Skill

如果只是看流程，直接阅读仓库中的文件即可：

```bash
cat codex-skills/boss-resume-ingest/SKILL.md
```

如果希望 Codex 在后续任务中自动使用这个 Skill，可以复制到本机 Codex skills 目录：

```bash
mkdir -p "$HOME/.codex/skills/boss-resume-ingest"
cp codex-skills/boss-resume-ingest/SKILL.md "$HOME/.codex/skills/boss-resume-ingest/SKILL.md"
```

复制后请先按自己的公司规则修改 Skill：

- 把岗位名称、岗位别名、筛选标准改成自己的业务口径。
- 明确哪些字段允许保留，哪些必须脱敏。
- 明确是否允许保存姓名、手机号、微信、邮箱、作品链接。
- 明确入库目标是本地 API、线上 API，还是飞书过渡脚本。
- 不要把真实公司名、内部人员名、飞书 base URL、token、BOSS 账号信息写进公开仓库。

## 第二步：启动面试工作台

本地开发环境：

```bash
npm install
cp .env.example .env
npm run dev
```

`.env` 至少需要配置：

```bash
PORT=8787
HOST=127.0.0.1
ADMIN_PASSWORD=change-this
COOKIE_SECRET=replace-with-random-string
INGEST_TOKEN=replace-with-a-private-token
```

打开管理后台：

```text
http://127.0.0.1:5173/
```

确认可以登录，并能看到人才库或候选人列表。

## 第三步：让 Codex 读取 BOSS 前端

推荐方式是让 Codex 控制已经登录的浏览器，而不是让它处理账号密码。

在 Codex 中发起任务时，可以这样描述：

```text
使用 boss-resume-ingest skill。请读取我当前 Chrome/BOSS 页面中这个候选人的可见简历信息，按脱敏规则整理成候选人 JSON。先不要写入，给我确认。
```

Codex 应执行的动作：

1. 打开或接管用户已经登录的 BOSS 页面。
2. 只读取当前候选人的会话、在线简历和附件摘要中可见的信息。
3. 不导出 cookie，不保存原始截图，不抓取无关聊天记录。
4. 把内容整理为结构化字段。
5. 对联系方式、内部链接、平台标识和不必要的个人信息做脱敏。
6. 向用户展示准备写入的 JSON，等待确认。

如果 Codex 不能直接控制浏览器，也可以手动复制候选人简历文字给 Codex，让它按同一套 Skill 整理。

## 第四步：候选人 JSON 格式

建议先整理成这个形状：

```json
{
  "bossName": "候选人A",
  "name": "候选人A",
  "role": "AI应用工程师",
  "currentLocation": "上海",
  "collectedDate": "2026-07-01",
  "source": "BOSS",
  "invitationStatus": "uninvited",
  "currentStage": "intake",
  "resumeText": "脱敏后的简历摘要，保留工作经历、项目经历、技能栈、教育背景、求职意向和风险点。",
  "basicInfo": "年龄/经验/学历等允许保留的信息",
  "jobIntent": "岗位、城市、薪资、到岗时间等",
  "workHistory": "脱敏后的工作经历",
  "projectHistory": "脱敏后的项目经历",
  "education": "脱敏后的教育背景",
  "skills": "技能关键词",
  "works": "[REDACTED_LINK] 或已获准保存的作品说明",
  "contactClues": "[REDACTED_CONTACT]",
  "nextStep": "建议下一步动作"
}
```

字段说明：

- `bossName`：BOSS 页面昵称；公开仓库示例里用 `候选人A`。
- `name`：真实姓名，只有在私有系统需要且合规时保存。
- `role`：应尽量匹配系统里的岗位画像名称。
- `currentLocation`：当前所在地，可用于现场办公判断。
- `resumeText`：AI 初筛最依赖的字段，应该完整但脱敏。
- `nextStep`：例如“请求项目材料”“发起异步面试”“安排二面”“暂不推进”。

## 第五步：通过 API 写入 SQLite

推荐写入路径是系统 API：

```bash
cat > candidate.json <<'JSON'
{
  "bossName": "候选人A",
  "name": "候选人A",
  "role": "AI应用工程师",
  "currentLocation": "上海",
  "collectedDate": "2026-07-01",
  "source": "BOSS",
  "invitationStatus": "uninvited",
  "currentStage": "intake",
  "resumeText": "这里放脱敏后的简历摘要。"
}
JSON

curl -X POST "http://127.0.0.1:8787/api/candidates" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  --data @candidate.json
```

写入后回到管理后台刷新人才库，确认候选人出现。

如果接口返回鉴权错误，检查：

- `.env` 中 `INGEST_TOKEN` 是否设置。
- curl 里的 token 是否和 `.env` 一致。
- 后端是否已经重启并加载最新 `.env`。
- 请求地址是否是后端端口 `8787`，不是前端端口 `5173`。

## 第六步：过渡期写入飞书

如果当前部署仍依赖飞书过渡表，可以使用脚本：

```bash
node scripts/upsert-boss-resume-to-feishu-library.mjs --write --file candidate.json
```

使用前需要在 `.env` 中配置：

```bash
LARK_CLI_PATH=/path/to/lark-cli
FEISHU_TENANT_URL=https://example.feishu.cn
```

并确保 `src/renderer/data/feishuResumeBaseConfig.json` 是你们私有环境里的真实配置。公开仓库中的版本是占位模板，不可直接写入真实飞书。

## 第七步：在工作台里继续招聘流程

候选人进入系统后，推荐流程是：

1. 在人才库中打开候选人详情。
2. 检查简历摘要是否脱敏且足够完整。
3. 点击或触发 AI 初筛。
4. 查看推荐等级、证据引用、风险点和定制题。
5. 如果继续推进，发起异步面试链接。
6. 候选人完成作答后，查看转写、逐题评分和总报告。
7. 根据报告安排真人二面或做结果反馈。

## 脱敏清单

上传 GitHub 前重点检查：

- `.env` 不存在于 git。
- `data/`、`backups/`、`outputs/` 不存在于 git。
- 没有真实候选人姓名、手机号、微信、邮箱、身份证号。
- 没有 BOSS 页面截图、附件原文、聊天全文。
- 没有飞书 base token、table id、tenant URL。
- 没有本机绝对路径、员工姓名、内部群名或公司专属规则。
- `codex-skills/boss-resume-ingest/SKILL.md` 保持通用模板，不含内部 SOP。

可用命令：

```bash
git status --short
rg -n "手机号|微信|身份证|真实飞书域名|app_token|base_token|cookie|Authorization|本机绝对路径" .
```

如果命中的是 README 或脱敏说明里的通用词，需要人工判断；如果命中真实值，先删除或改成占位符再提交。

## 给 Codex 的推荐提示词

整理但不写入：

```text
使用 boss-resume-ingest skill。请读取当前 BOSS 候选人页面，把可见简历整理成脱敏 JSON。不要保存截图，不要写入系统，先给我确认。
```

确认后写入本地工作台：

```text
使用 boss-resume-ingest skill。把刚才确认过的候选人 JSON 写入本地面试工作台 API，地址是 http://127.0.0.1:8787，使用环境变量 INGEST_TOKEN。写入后帮我验证人才库是否出现。
```

过渡期写入飞书：

```text
使用 boss-resume-ingest skill。把这个脱敏候选人 JSON 用 scripts/upsert-boss-resume-to-feishu-library.mjs 写入飞书过渡简历库。执行前先展示将写入的字段。
```

## 常见问题

### 为什么要用 Codex，而不是直接做浏览器爬虫？

BOSS 页面经常变化，也包含大量上下文、权限和隐私判断。Codex 更适合在人工授权下读取当前页面、理解简历内容、做字段归一化和脱敏，再交给用户确认。这样比无监督爬虫更稳，也更容易符合合规边界。

### 可以批量处理吗？

不建议用这个 Skill 做无监督批量抓取。批量处理应该优先使用平台允许的导出、企业授权 API 或用户手工提供的文件，并在入库前做脱敏检查。

### 真实联系方式要不要保存？

由你的私有招聘流程决定。公开仓库、截图、日志和示例文件中不要保存。私有系统如果确实需要保存手机号或微信，应限制权限、避免进入日志，并明确保留周期。

### 公开仓库中的 Skill 能直接用吗？

只能作为模板。使用前必须按自己的岗位画像、字段映射、合规要求、部署地址和 token 管理方式修改。
