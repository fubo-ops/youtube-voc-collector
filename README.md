# YouTube VOC Collector

通用 Amazon 产品驱动的公开 YouTube 原始评论采集 Skill。输入 Amazon US ASIN 后，程序从商品标题、五点描述与 SellerSprite 可见关键词建立 `product_context`，生成产品名、品类、属性、场景、问题、效果、材料/成分、购买意图和替代品查询族，再采集公开视频中的主评论和可见回复。

## 安装

```powershell
git clone https://github.com/fubo-ops/youtube-voc-collector.git
cd youtube-voc-collector
npm ci
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\doctor.ps1
```

需要 Node.js 22+、Python 3.10–3.13 和 Google Chrome。

## 运行

```powershell
node scripts\youtube_playwright_collector.cjs --help
node scripts\youtube_playwright_collector.cjs preflight --asin B0HMGGX71C --headless 0 --profile-dir .youtube-voc-browser-profile
node scripts\youtube_playwright_collector.cjs --asin B0HMGGX71C --target-comments 800 --videos-per-query 15 --max-comments-per-video 50 --max-reply-actions 15 --detail-concurrency 3 --headless 0 --profile-dir .youtube-voc-browser-profile
```

默认输出到当前工作目录的 `YouTube评论采集/<ASIN>`。`--resume` 会合并新的 `--expanded-keywords`，保留候选池，并跳过已完成查询和视频。

## 采集规则

- 查询由当前产品语义生成，不依赖固定品类词。
- 视频审核排除跨品类、错误物种、人类用途及无关 ASMR。
- 所有成功读取的公开评论和回复均进入 `Raw_Comments`；审核和相关性只作附加字段。
- 仅按稳定评论 ID 技术去重；缺失 ID 时仅按 `video_id + author + comment_text` 完全一致去重。
- 每条记录均为 comment，独立视频记录始终为 0。

## 输出与验证

输出 JSONL、CSV、Query Plan、manifest、checkpoint、视频证据与 Excel。Excel 包含 `Raw_Comments`、`Query_Plan`、`Video_Audit`、`Run_Summary`、`Quality_Gate`。Quality Gate 只检查字段、URL、父子关系、技术重复、记录类型和输出数量一致性。

```powershell
npm test
npm run check
python -m unittest discover -s tests -v
python scripts\quick_validate.py .
```

只处理公开可见内容；不读取或导出 Cookie、密码、Token，不自动登录或处理验证码，不绕过访问限制。字段说明见 `references/raw-record-schema.md`。
