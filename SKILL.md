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

### 第 5 步：输出报告

汇总为 Markdown 报告（脚本已生成主体），补充人工仲裁结果后交付给用户，报告必须包含：

- 总条数 + 四类计数（通过 / 有问题 / 需人工 / 失败）
- **❌ 问题条目详情**（放最前面）：每个问题条目列出 bib 写法 vs 权威来源写法的对照表，并给出可直接粘贴的修正后 BibTeX 片段
- ✅ 通过条目清单（一行一条，注明核对来源）
- 最终结论：是否存在虚构文献（学术不端风险）

## 已知坑（本机环境）

- Crossref 429 限流很常见，**必须区分 429（限流，重试）和 404（真不存在）**，把 429 当"文献不存在"是本流程最大错误
- Bash 工具缺 coreutils（sleep/ls/cat 等），脚本内已全部用 Node 原生实现，勿改成 shell 管道
- DBLP API 也会 429，连续查询要间隔
- IEEE Xplore 页面国内访问不稳定且有登录墙，不要依赖它做主判据

## 资源

### scripts/
- `verify_bib.js` — 核查主脚本（Node ≥18，无第三方依赖）。用法：`node verify_bib.js <bib路径> [--out 报告.md] [--delay 毫秒]`
