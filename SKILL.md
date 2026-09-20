---
name: bib-verification
description: 核查 BibTeX (.bib) 文献库的真实性与元数据准确性，防止引用虚构文献（学术不端）。当用户要求"查 bib 真实性""核查参考文献""检查引用是否真实存在""验证 DOI""文献是不是编的""查重文献"时使用。流程：解析 bib → Crossref API 批量校验 DOI → CVF 官网抓取比对 → DBLP/WebSearch 仲裁存疑条目 → 输出核查报告。
agent_created: true
---

# BibTeX 文献真实性核查

## 概述

对 .bib 文件中的每条文献逐条验证：论文是否真实存在、标题/作者/年份/期刊/DOI 是否与官方记录一致。核心原则：**一条文献必须能对上至少一个权威来源（出版社元数据库或官方会议网站）才算通过；对不上就用第二来源仲裁；两个来源都查不到的标记为可疑（可能虚构）。**

## 核查工作流（按顺序执行）

### 第 1 步：解析并分类

读取用户的 .bib 文件，把条目分成三类：

1. **带 `doi` 字段** → 走 Crossref 校验（第 2 步），占绝大多数
2. **无 DOI 但 `url` 指向 `openaccess.thecvf.com`** → 走 CVF 抓取（第 3 步）
3. **两者都没有** → 标记 NEEDS_MANUAL，走第 4 步人工仲裁

### 第 2 步：Crossref 批量校验（带 DOI 的条目）

运行捆绑脚本（无需自己写代码）：

```bash
node <skill目录>/scripts/verify_bib.js <bib文件绝对路径> --out <报告输出路径.md>
```

脚本自动完成：DOI → Crossref API 查询、标题归一化模糊比对、年份比对（±1 年视为可接受，如会议 2024 / LNCS 正式出版 2025）、作者列表逐位比对（按姓氏归一化）。带 429 限流退避重试，速率控制在约 1.2s/条。

**判读规则：**
- `VERIFIED` → 通过，标题+年份+作者全对上
- `METADATA_MISMATCH` → 论文真实但元数据有错（最常见：作者名拼写错误），看 problems 字段定位差异
- `DOI_NOT_FOUND`（HTTP 404）→ **高度可疑，DOI 在 Crossref 无记录**，可能虚构或 DOI 抄错，转第 4 步仲裁
- `HTTP_429` / `ERROR` → 是限流/网络问题，**不是文献不存在**，等 1–2 分钟重跑脚本即可

### 第 3 步：CVF 官网抓取（无 DOI 的 CVPR/ICCV/WACV 论文）

脚本会自动抓 `openaccess.thecvf.com` 页面，提取 `#papertitle` 和 `#authors` 与 bib 比对。若脚本报 HTTP 错误，用 WebFetch 直接访问 bib 里的 url 核对。

### 第 4 步：存疑条目仲裁

对 DOI_NOT_FOUND、作者不符、或 NEEDS_MANUAL 的条目，按优先级用第二来源仲裁：

1. **DBLP**：`https://dblp.org/search/publ/api?q=<标题关键词>&format=json` —— 作者名单以此为准最可靠（注意 DBLP 也限流，间隔 3s 以上）
2. **WebSearch**：直接搜论文标题（**只搜标题，别带 bib 里的作者名**——作者名可能本身就是错的，带着搜会搜不到）
3. **Semantic Scholar / ADS**：DBLP 查不到时的备选

**经典文献豁免**：Adam、SGDR、ResNet 这类引用量百万级的文献可直接判定真实，但仍建议核对作者拼写。

### 第 4.5 步：严格复核（推荐，尤其"查是否编造"场景）

脚本的 `titleMatches()` 用的是**归一化子串包含**，偏松——能证明"标题不是编的"，但漏得掉"DOI 正确、标题被截断/篡改"。同时脚本**不校验 volume / number / pages**。建议再跑一轮严格比对：逐字标题相等 + 卷/期/页逐项相等，输出差异表。

实测模板（可直接改路径复用）：`strict_audit.js` 一次遍历全部 DOI 条目，输出 `{exactTitle, bibVol/xVol, bibNum/xNum, bibPages/xPages, bibYear/xYear}` 并只打印异常项。放在工作区根目录跑即可。

### 第 5 步：输出报告

汇总为 Markdown 报告（脚本已生成主体），补充人工仲裁结果后交付给用户，报告必须包含：

- 总条数 + 四类计数（通过 / 有问题 / 需人工 / 失败）
- **❌ 问题条目详情**（放最前面）：每个问题条目列出 bib 写法 vs 权威来源写法的对照表，并给出可直接粘贴的修正后 BibTeX 片段
- ✅ 通过条目清单（一行一条，注明核对来源）
- 最终结论：是否存在虚构文献（学术不端风险）

## 已知坑（本机环境）

- Crossref 429 限流很常见，**必须区分 429（限流，重试）和 404（真不存在）**，把 429 当"文献不存在"是本流程最大错误
- Bash 工具缺 coreutils（sleep/ls/cat 等），脚本内已全部用 Node 原生实现，勿改成 shell 管道
- DBLP API 也会 429，连续查询要间隔；**2026-09 起 dblp.org 被 Anubis 反爬拦截，返回 HTML 挑战页而非 JSON**，
  此时改用 Semantic Scholar（`https://api.semanticscholar.org/graph/v1/paper/DOI:<doi>?fields=title,venue,year,journal`，
  会 429，间隔 3s 以上）或 WebSearch 仲裁，不要在这一步死磕 DBLP。
- IEEE Xplore 页面国内访问不稳定且有登录墙，不要依赖它做主判据
- **不要用 Bash heredoc 写临时校验脚本**：脚本里含 `${a.given}` 这类 JS 模板字符串/解构语法时，
  shell 会当变量替换并报 `Bad substitution`（加引号的 `<<'EOF'` 在本机 shim 下也一样炸）。一律用 Write 工具落盘再 `node` 跑。
- 临时脚本用完记得删（用 `node -e "fs.unlinkSync(...)"`，本机 `rm` 不可用）

### 两个会导致误判/误报的隐藏坑（务必记住）

1. **`checkCVF()` 有假阳性通道**：若页面抓不到 `<div id="papertitle">`（软 404、改版、被拦），
   `xTitle` 为空字符串 → 不 push 任何 problem → 直接判 `VERIFIED`，实际**什么都没验证**。
   看到无 DOI 的 CVF 条目报 VERIFIED 时，**必须用 WebFetch 打开 URL 人工确认标题/作者**再下结论。
   同理 `authorsMatch()` 在任一侧作者列表为空时返回 `null`（不报错），也等于跳过校验。

2. **CVF 页码 ≠ IEEE Xplore 页码**：CVPR/ICCV/WACV 同一篇论文，`openaccess.thecvf.com` 网页与其官方
   BibTeX 给出的 `pages`，和 Crossref（来自 IEEE Xplore）的 `page` **经常不一样**，差异可以是 1 页也可以是 10 页。
   实测：WACV2021 ACM 950-959(CVF) vs 949-958(IEEE)；CVPR2022 ISNet 877-886(CVF) vs 867-876(IEEE)；
   WACV2024 RPCANet 4809-4818(CVF) vs 4797-4806(IEEE)。
   **结论：bib 页码只要与 CVF 或 IEEE 任一方官方记录吻合就不算错误，不要报成 METADATA_MISMATCH。**
   真正该提醒用户的是"条目同时挂了 CVF 的 url 和 IEEE 的 doi"这种**混用**写法——两套页码会打架，
   建议统一到与 `url` 一致的那一套。判定依据：抓 CVF 页面里的 `bibref` 块（`@InProceedings{...pages={...}}`）。

## 资源

### scripts/
- `verify_bib.js` — 核查主脚本（Node ≥18，无第三方依赖）。用法：`node verify_bib.js <bib路径> [--out 报告.md] [--delay 毫秒]`
- `strict_audit.js` — 严格复核（第 4.5 步）。用法：`node strict_audit.js <bib路径> [--delay 1300]`。
  逐字比对标题 + volume/issue/pages/year，只打印异常项；带 CVF url 的条目页码差异降级为 `[i ]` INFO。

  **写这个脚本踩过的坑（务必记住）**：BibTeX 惯例页码写 `4996--5009`（双连字符），Crossref/IEEE 写 `4996-5009`
  （单连字符），二者等价。归一化时若只处理 Unicode 破折号而漏掉 ASCII `-`，会**满屏误报页码不符**（实测 33/46 条）。
  正确写法：`s.replace(/[\u002D\u2010-\u2015\u2212\uFF0D]/g,"-").replace(/-+/g,"-")`。
