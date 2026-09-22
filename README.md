# YouTube VOC Collector

一套可独立运行、也可作为 Codex Skill 使用的公开 YouTube VOC 评论采集器。输入一个或多个 Amazon US ASIN 后，从 Amazon 商品信息和 SellerSprite 可见关键词生成查询计划，搜索 YouTube 视频并保存公开主评论与可见回复。

## 支持环境

- Windows 10/11、macOS、Linux（独立 Chrome CDP 模式以 Windows 脚本为主）
- Python 3.10–3.13
- Node.js 22+
- Google Chrome

GitHub Actions 在三种操作系统及 Python 最低、最高支持版本上运行 Python、Node 和 Skill 验证。

## 安装

```powershell
git clone https://github.com/fubo-ops/youtube-voc-collector.git
cd youtube-voc-collector
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
npm ci
```

安装为 Codex Skill：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\doctor.ps1
```

## 运行

查看完整参数：

```powershell
node scripts\youtube_playwright_collector.cjs --help
python scripts\normalize_raw_jsonl.py --help
```

单 ASIN 示例：

```powershell
node scripts\youtube_playwright_collector.cjs --asin B003ULL1NQ --target-videos 100 --comments-per-video 20 --headless 0
```

ASIN 组示例：

```powershell
node scripts\youtube_playwright_collector.cjs --asins B003ULL1NQ,B000000000 --max-queries all --videos-per-query 15 --comments-per-video 20 --headless 0
```

默认输出到当前工作目录的 `outputs/youtube`。使用已有登录状态时传入独立的 `--profile-dir`；不要把该目录提交到仓库。

## 输出

- comments-only JSONL 与 CSV
- Query Plan、manifest、checkpoint 和视频审计证据
- 原生 Excel，主工作表为 `Raw_Comments`
- 每条记录均为 `record_type: "comment"`，通过 `source_parent_id = video:<video_id>` 追溯视频
- 只按稳定 comment ID，或 ID 缺失时的完整一致组合去除技术重复

Excel 生成器优先使用 Codex 随附的 artifact-tool。公共 CI 缺少该私有运行时组件时会跳过 Excel 集成测试，其余采集、标准化和数据契约测试仍完整执行。

## 安全边界

- 只处理公开可见内容和公开可见回复。
- 不读取、导出或提交 Cookie、密码、Token、浏览器 Profile 或历史记录。
- 不自动登录、不处理验证码、不绕过登录、年龄、地区、会员或私有视频限制。
- `.gitignore` 排除 outputs、profile、Excel、JSONL、日志、缓存和环境文件。

详细流程见 `SKILL.md` 与 `references/collection-guide.md`；字段见 `references/raw-record-schema.md`。

## 测试

```powershell
python -m unittest discover -s tests -v
npm test
npm run check
python scripts\quick_validate.py .
```

## 许可证

MIT，见 `LICENSE`。
