# bib-verification

BibTeX 文献真实性核查 Skill —— 防止引用虚构文献（学术不端）的 WorkBuddy Agent Skill。

## 功能

对 `.bib` 文件中的每条文献逐条验证：

1. **带 DOI 的条目** → 批量调用 Crossref API，比对标题（归一化模糊匹配）、年份（±1 容忍，兼容"会议 2024 / LNCS 出版 2025"）、**作者全名逐位比对**（可发现 Liwei/Liuwei 这类拼写错误；首字母缩写如 "Y." 自动容错）
2. **无 DOI 的 CVF 会议论文**（CVPR/ICCV/WACV）→ 抓取 openaccess.thecvf.com 官方页面提取标题与作者比对
3. **两者皆无的条目** → 标记 NEEDS_MANUAL，按 DBLP → WebSearch → Semantic Scholar 优先级人工仲裁
4. **重复字段检测** → 同一条目内出现两个 `author` 等字段时报警（BibTeX 只会静默使用其中一个，极易埋雷）
5. **严格复核**（`strict_audit.js`）→ 在主脚本之上再做一轮逐字标题比对 + volume / number / pages / year 逐项校验

判读规则内置：严格区分 **HTTP 429（限流，需重试）** 与 **404（DOI 无记录，高度可疑可能虚构）**；带指数退避限速重试。

## 安装（WorkBuddy）

```bash
# Windows / 用户级
git clone https://github.com/yjfingit/bib-verification.git "%USERPROFILE%\.workbuddy\skills\bib-verification"
```

安装后在对话中说"帮我核查 xxx.bib 的文献真实性"即可触发。

## 命令行直接使用

```bash
# 第一轮：主核查
node scripts/verify_bib.js <path/to/references.bib> --out report.md [--delay 1200]

# 第二轮（推荐）：严格复核，逐字标题 + 卷/期/页/年份
node scripts/strict_audit.js <path/to/references.bib> [--delay 1300]
```

- 依赖：Node.js ≥ 18（仅内置模块，零第三方依赖）
- 输出：控制台进度 + Markdown 核查报告
- `verify_bib.js` 退出码：`0` 全部通过 / `1` 查询失败（建议重跑）/ `2` 发现问题条目

两个脚本的区别：`verify_bib.js` 的标题比对是**归一化子串包含**，偏松，且不校验卷期页码；
`strict_audit.js` 补上严格比对，只打印异常项。查"是否编造"时建议两个都跑。

## 报告内容

- ❌ 问题条目详情：bib 写法 vs 权威来源写法对照，附可粘贴的修正 BibTeX
- ⏳ 需人工核查 / ⚠️ 查询失败条目清单
- ✅ 验证通过条目清单（注明核对来源）
- 最终结论：是否存在虚构文献（学术不端风险）

## 关键判据（避免误报）

- **429 ≠ 文献不存在**。Crossref 限流很常见，429 要退避重试；只有 404 才是"DOI 无记录"。把 429 当"不存在"是本流程最大的错误。
- **CVF 页码 ≠ IEEE Xplore 页码**。同一篇 CVPR/ICCV/WACV 论文，`openaccess.thecvf.com` 的页码与 Crossref（源自 IEEE Xplore）的页码经常差 1–12 页，两者都是官方口径。bib 只要与任一方吻合就不算错。
- **无 DOI 的 CVF 条目若报 VERIFIED，要人工确认一次**。页面抓不到 `#papertitle` 时脚本不会报错而是静默判过。
- **DBLP API 有反爬拦截**（返回 HTML 挑战页而非 JSON），查不到时直接改用 WebSearch 搜标题，别死磕。

## 实战记录

2026-09-20 用本 skill 核查一份 50 条红外小目标检测（IRSTD）文献库：

- 50 条全部能对上权威来源，**0 条虚构**
- 抓出 1 条作者名三处拼写错误（ISTDU-Net：`Zhang, Liwei`→`Liuwei`、`Xi, Yuhang`→`Yuyang`、`Li, Nanjian`→`Li, Na`），经 Crossref / DBLP / NASA ADS / Semantic Scholar 四方确认
- 严格复核：46 条带 DOI 条目中 43 条逐字完全一致，标题/卷/期/年 0 处不符；3 条为 CVF 与 IEEE 页码口径差异（非错误）
- 2025–2026 年的新文献（DOI 最易被编造的一类）逐条单独回查，全部命中

## Changelog

### 2026-09-20

- 新增 `scripts/strict_audit.js`（严格复核：逐字标题 + 卷/期/页/年份），此前 SKILL.md 引用了该文件但仓库中缺失
- 修复页码归一化的满屏误报：BibTeX `4996--5009` 与 Crossref `4996-5009` 等价，归一化必须一并处理 ASCII 连字符
- SKILL.md 补充：DBLP 反爬拦截、Semantic Scholar 无 key 必 429、heredoc 写 JS 脚本会 `Bad substitution`、CVF/IEEE 页码双口径、CVF 校验的假阳性通道

## License

MIT
