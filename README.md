# bib-verification

BibTeX 文献真实性核查 Skill —— 防止引用虚构文献（学术不端）的 WorkBuddy Agent Skill。

## 功能

对 `.bib` 文件中的每条文献逐条验证：

1. **带 DOI 的条目** → 批量调用 Crossref API，比对标题（归一化模糊匹配）、年份（±1 容忍，兼容"会议 2024 / LNCS 出版 2025"）、**作者全名逐位比对**（可发现 Liwei/Liuwei 这类拼写错误；首字母缩写如 "Y." 自动容错）
2. **无 DOI 的 CVF 会议论文**（CVPR/ICCV/WACV）→ 抓取 openaccess.thecvf.com 官方页面提取标题与作者比对
3. **两者皆无的条目** → 标记 NEEDS_MANUAL，按 DBLP → WebSearch → Semantic Scholar 优先级人工仲裁
4. **重复字段检测** → 同一条目内出现两个 `author` 等字段时报警（BibTeX 只会静默使用其中一个，极易埋雷）

判读规则内置：严格区分 **HTTP 429（限流，需重试）** 与 **404（DOI 无记录，高度可疑可能虚构）**；带指数退避限速重试。

## 安装（WorkBuddy）

```bash
# Windows / 用户级
git clone https://github.com/yjfingit/bib-verification.git "%USERPROFILE%\.workbuddy\skills\bib-verification"
```

安装后在对话中说"帮我核查 xxx.bib 的文献真实性"即可触发。

## 命令行直接使用

```bash
node scripts/verify_bib.js <path/to/references.bib> --out report.md [--delay 1200]
```

- 依赖：Node.js ≥ 18（仅内置模块，零第三方依赖）
- 输出：控制台进度 + Markdown 核查报告
- 退出码：`0` 全部通过 / `1` 查询失败（建议重跑）/ `2` 发现问题条目

## 报告内容

- ❌ 问题条目详情：bib 写法 vs 权威来源写法对照，附可粘贴的修正 BibTeX
- ⏳ 需人工核查 / ⚠️ 查询失败条目清单
- ✅ 验证通过条目清单（注明核对来源）

## 实战记录

2026-09-20 用本 skill 核查一份 50 条红外小目标检测（IRSTD）文献库：全部真实存在，抓出 1 条作者名三处拼写错误（ISTDU-Net）及 1 处重复 `author` 字段，修复后全绿。

## License

MIT
