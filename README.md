# YouTube VOC 评论采集器

## 一眼看懂

- 这是什么：按商品编号找 YouTube 公开视频并采评论。
- 什么时候用：想听视频评测和开箱里观众怎么说这款商品时。
- 给它什么：商品编号，和一个装好 Chrome 的电脑。
- 它给你什么：五张表的 Excel，含视频来源和评论回复。

## 项目简介

`youtube-voc-collector` 是由 Amazon US 商品驱动的 YouTube 公开评论采集工具，也可作为 Codex Skill 使用。输入单个 ASIN、ASIN 组或文件后，程序从当前商品标题、五点和可见卖家精灵词建立产品语境，发现相关公开视频，读取主评论和可见回复，输出可追溯的原始数据及 Excel。

仓库只做采集层：成功读取的公开评论仅按稳定 ID 做技术去重，视频只用于来源追溯、不单独成行；评论相关性和审核状态是附加诊断字段，不改变原始数据保留策略。仓库不采集登录凭据、不自动登录、不绕过年龄或地区限制。

## 核心功能

- 🔎 **商品驱动**：按 ASIN 生成查询族
- 🧠 **视频审核**：过滤错品类与无关视频
- 💬 **评论采集**：主评论与可见回复一并存
- 🧹 **技术去重**：按稳定评论 ID 去重
- 🔁 **断点续跑**：原子断点，合并新增词
- 🚦 **限额控制**：按配置限制数量与并发
- 📊 **五表交付**：原始证据与 Excel 齐出

## 技术栈

| 层级 | 技术 | 版本 |
| --- | --- | --- |
| 语言 | Python | 3.12.13 |
| 语言 | Node.js（CI 固定 22） | — |
| 浏览器自动化 | Playwright（本机 Chrome / Chromium） | >=1.55.0 <2 |
| Python 依赖 | PyYAML | — |
| Excel 导出 | Codex `@oai/artifact-tool` | — |
| 测试 | Node test runner + Python `unittest` | — |
| CI | GitHub Actions（Windows / macOS / Ubuntu） | — |

版本取自 `.python-version`、`package.json`、`pyproject.toml` 和 `requirements.txt`。Node.js 只在 CI 工作流里固定为 22，未写入依赖文件，记「—」；PyYAML 仅约束主版本 `>=6,<7`，无可比版本号，记「—」；Excel 导出依赖由 Codex 运行环境提供，不在公开依赖中。

## 快速开始

需要 Node.js 22、Python 3.10–3.13（本机 `.python-version` 为 3.12.13）和已装好的 Google Chrome。以下命令在仓库根目录执行，尖括号占位符请替换成本机真实值；Windows PowerShell 激活虚拟环境用 `.venv\Scripts\Activate.ps1`。

1. 克隆仓库，安装 Python 与 Node 依赖

   ```bash
   git clone https://github.com/fubo-ops/youtube-voc-collector.git
   cd youtube-voc-collector
   python -m venv .venv
   source .venv/bin/activate
   python -m pip install -r requirements.txt
   npm ci
   ```

2. 先跑预检，确认浏览器与访问就绪

   ```bash
   node scripts/youtube_playwright_collector.cjs preflight --asin <ASIN> --headless 0 --profile-dir .youtube-voc-browser-profile
   ```

3. 正式采集，输出默认落在 `YouTube评论采集/<ASIN>`

   ```bash
   node scripts/youtube_playwright_collector.cjs --asin <ASIN> --target-comments 800 --videos-per-query 15 --max-comments-per-video 50 --max-reply-actions 15 --detail-concurrency 3 --headless 0 --profile-dir .youtube-voc-browser-profile
   ```

4. 中断后续跑，传入该批实际的 checkpoint 文件

   ```bash
   node scripts/youtube_playwright_collector.cjs --asin <ASIN> --resume <RUN_DIR>/RUN_checkpoint.json --expanded-keywords "PRODUCT QUERY,USE CASE QUERY"
   ```

5. 跑离线测试与语法检查，确认改动没破坏契约

   ```bash
   npm test
   npm run check
   python -B -m unittest discover -s tests -v
   python -B scripts/quick_validate.py .
   ```

6. 可选：装成 Skill 并做安装自检

   ```bash
   powershell -ExecutionPolicy Bypass -File ./install.ps1
   powershell -ExecutionPolicy Bypass -File ./doctor.ps1
   ```

采集结束时会调用 Excel 构建器，需能解析到 Codex 的 `@oai/artifact-tool`，否则 XLSX 导出不完整。`doctor.ps1` 只检查安装文件、Node 语法和命令帮助，不代表浏览器实采可用。

## 项目结构

只列两层，完整文件清单见文末《详细说明》。

```text
youtube-voc-collector/
├── .github/                            # CI 工作流
├── agents/                             # Codex Skill 元数据
├── references/                         # 采集指南与字段契约
├── scripts/                            # 采集、规范化与构建脚本
│   ├── youtube_playwright_collector.cjs # 采集命令行入口
│   ├── youtube_voc_core.cjs            # 查询生成与去重核心
│   ├── build_youtube_excel.mjs         # 五表 Excel 构建
│   ├── normalize_raw_jsonl.py          # 原始 JSONL 规范化
│   └── rebuild_raw_collection.cjs      # 从原始数据重建采集结果
├── tests/                              # 离线测试与预检 fixture
├── CHANGELOG.md                        # 版本更新记录
├── LICENSE                             # MIT 许可证
├── SKILL.md                            # Skill 入口与执行流程
├── VERSION                             # 发布版本号
├── package.json                        # Node 依赖（Playwright）
├── pyproject.toml                      # Python 项目元数据
├── requirements.txt                    # Python 依赖（PyYAML）
└── install.ps1                         # Skill 安装脚本
```

## 架构图

`youtube_voc_core.cjs` 负责确定性的查询生成与视频审核，Playwright 只负责读取公开可见内容：

```text
【采集主链路】
┌────────────────────────────────────────────┐
│   ASIN / ASIN 组 / ASIN 文件               │
└──────────────────────┬─────────────────────┘
                       ▼
┌────────────────────────────────────────────┐
│   preflight：登录态与访问就绪检查           │
└──────────────────────┬─────────────────────┘
                       ▼
┌────────────────────────────────────────────┐
│   Amazon 标题、五点与卖家精灵词 → 产品语境  │
└──────────────────────┬─────────────────────┘
                       ▼
┌────────────────────────────────────────────┐
│   youtube_voc_core.cjs：查询族生成与视频审核 │
└──────────────────────┬─────────────────────┘
                       ▼
┌────────────────────────────────────────────┐
│   Playwright：读取公开主评论与可见回复      │
└──────────────────────┬─────────────────────┘
                       ▼
┌────────────────────────────────────────────┐
│   技术去重 + 父子关系还原                   │
└──────────────────────┬─────────────────────┘
                       ▼
┌────────────────────────────────────────────┐
│   JSONL / CSV / 查询计划 / 证据 / manifest  │
└──────────────────────┬─────────────────────┘
                       ▼
┌────────────────────────────────────────────┐
│   build_youtube_excel.mjs → 五表 Excel      │
└──────────────────────┬─────────────────────┘
                       ▼
┌────────────────────────────────────────────┐
│   Quality_Gate：字段、URL、父子、数量校验   │
└────────────────────────────────────────────┘

【断点与续跑】
查询任务、视频状态和回复动作各存原子断点；
续跑读取 checkpoint，合并新增扩展词并跳过已完成任务。
```

默认输出目录是当前目录下的 `YouTube评论采集/<ASIN>`；评论、店铺数据、浏览器资料、断点和输出文件都不提交到 Git。

## 开发计划

### Phase 1: 采集核心

- ✅ 单 ASIN、ASIN 组与文件三种输入
- ✅ 产品语境驱动的查询族生成
- ✅ 视频与产品关联审核

### Phase 2: 数据与断点

- ✅ 稳定评论 ID 技术去重
- ✅ 原子断点与续跑合并新增词
- ✅ 视频数、评论数、回复动作与并发限额

### Phase 3: 交付与分发

- ✅ JSONL、CSV、查询计划、证据与 manifest 输出
- ✅ 五表 Excel（Raw_Comments 等五张）
- ✅ Windows 安装、卸载与发布打包脚本
- ✅ 规范化、恢复与重建脚本

### Phase 4: 工程化与验证

- ✅ GitHub Actions（Windows / macOS / Ubuntu）
- ✅ 分发契约测试（发布包与独立 Skill）
- ⬜ 各平台浏览器实采验收
- ⬜ 独立后续开发路线图

## 文档

- [Skill 入口](SKILL.md)
- [采集参数、查询、停止与续跑规则](references/collection-guide.md)
- [原始评论字段与质量契约](references/raw-record-schema.md)
- [版本更新记录](CHANGELOG.md)
- [安全与数据边界](SECURITY.md)
- [安装脚本](install.ps1)与[环境检查](doctor.ps1)
- [发布打包脚本](build_release.ps1)
- [CI 配置](.github/workflows/test.yml)

## 许可证

采用 [MIT License](LICENSE)。

---

原 README 里的环境准备、Skill 安装细节、完整参数、数据边界、项目文件清单与当前状态等细节，已全部迁移到 [docs/详细说明.md](docs/详细说明.md)。
