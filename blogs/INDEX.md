# A1111 改造手记 · 文章台账

> 一个持续半年的个人分叉：把 A1111 WebUI 从“生成表单”改造成“AI 绘画工作台”。
> 面向知乎发布。文章与截图都在 `blogs/`，本文件记录写了什么、图从哪来、发布前还要做什么。

## 文章信息

| 项 | 内容 |
|---|---|
| 标题 | 半年、121 次提交：我把 A1111 改成了自己的 AI 绘画工作台 |
| 文件 | [01-workbench-tour.md](01-workbench-tour.md) |
| 状态 | ✅ 完稿（待发布） |
| 平台 | 知乎（中文） |
| 体裁 | 阶段性总结 + 界面导览（图多） |
| 正文字数 | 约 3,400 汉字 |
| 截图 | 20 张，见下方清单 |
| 基线 | AUTOMATIC1111/stable-diffusion-webui v1.10.1（`82a973c`，2024-07-27） |
| 统计口径 | `git log master..dev`，2026-04-28 → 2026-10-23 |

## 进度

- 已完稿：1 篇
- 已发布：0 篇
- 截图：20 张（全部来自本机运行中的实例）
- 待办：把 `assets/` 里的图按顺序上传到知乎，替换 Markdown 的相对路径

## 文章结构

1. **它现在是什么**：分叉基线、121 次提交 / 207 个文件 / +6.9 万行、十个页签、四段流水线；含“为什么是分叉，不是重写”（不重写推理内核、不追上游、不为陌生人做兼容，以及 ComfyUI 的对比）。
2. **说得清**：提示词从 textarea 变成文档（CodeMirror 6、行号、注释、`@PICK`、语法检查）。
3. **算得出**：sidecar 模式、Krea 2 / Qwen / Nano Banana、Job Queue、控制面与数据面分离。
4. **存得下**：Gallery v2（权威库、blob 存储、来源注册表、状态机、FTS）、迁移数字与双轨策略。
5. **用得上**：Composer / Censor / Inpaint、Mobile Lite 六屏与入口设置。
6. **代价与现状**：个人分叉的三条规矩、不完美之处、上游维护成本。
7. **功能清单**：把现有能力压成一张清单。
8. **接下来**：继续打磨的方向与收尾。

## 截图清单

| 文件 | 展示内容 | 用在哪一节 | 备注 |
|---|---|---|---|
| `assets/08-composer.png` | 桌面端 Composer：图层、画布、输出、顶部页签 | 开篇主图 / 用得上 | 已加载演示图 |
| `assets/01-prompt-editor.png` | CodeMirror 提示词：行号、`@PICK`、注释行、token 计数 | 说得清 | 桌面端 |
| `assets/02-txt2img-result.png` | 一次 4 张的结果、参数与动作按钮 | 说得清 | txt2img |
| `assets/12-krea2.png` | Krea 2 sidecar 生命周期与参数 | 算得出 | 已隐藏模型描述行 |
| `assets/13-qwen.png` | Qwen-Image 2.1 sidecar 与参数 | 算得出 | 状态为 stopped |
| `assets/11-nano-banana.png` | 单图 / Image Maker / Comic Maker / LoRA Data Maker | 算得出 | 已裁掉 API Key 行 |
| `assets/14-queue.png` | Job Queue：暂停/恢复/清理/状态 | 算得出 | 空队列 |
| `assets/03-gallery-filters.png` | 图库筛选：搜索、排序、时间、评分、尺寸、快捷筛选 | 存得下 | 搜索 `bookshop` |
| `assets/04-gallery-grid.png` | 图库卡片：缩略图、尺寸、体积、来源、时间 | 存得下 | 4 张演示图 |
| `assets/05-gallery-detail.png` | 详情抽屉：预览、评分/状态、发送到、专辑、标签 | 存得下 | 已隐藏相册条 |
| `assets/06-gallery-metadata.png` | 提示词、参数、路径、种子 | 存得下 | 详情下半部分 |
| `assets/07-gallery-viewer.png` | 全屏查看器：缩放、平铺、对比、保存 | 存得下 | 演示图 |
| `assets/09-censor.png` | Censor：线 / 马赛克 / 高斯模糊 | 用得上 | 已加载演示图 |
| `assets/10-inpaint-editor.png` | Inpaint + SAM：画笔/橡皮/遮罩扩展 | 用得上 | 已裁剪空白区域 |
| `assets/15-settings-mobile.png` | Mobile lite 入口设置：Auto / Always / Disabled | 用得上 | Settings |
| `assets/16-mobile-text.png` | 手机端 Text：提示词、参数、结果、底部导航 | 用得上 | 390×900 |
| `assets/18-mobile-image.png` | 手机端 Image：图片 + chips 提示词 | 用得上 | 从图库带入 |
| `assets/19-mobile-inpaint.png` | 手机端遮罩编辑器：画笔/橡皮/SAM | 用得上 | 已画一条遮罩 |
| `assets/17-mobile-gallery.png` | 手机端 Gallery：搜索、状态、批量操作 | 用得上 | 已隐藏相册 chip 行 |
| `assets/20-mobile-compose.png` | 手机端 Compose：图层、工具、输出 | 用得上 | 已加载演示图 |

## 截图约定（重要）

- **只用演示图**：文章里的图库截图全部来自专门生成的 4 张 `bookshop` 主题图；没有使用私人图库内容。
- **不出现密钥**：Nano Banana 截图裁掉了 API Key 行；任何截图都不要包含密钥、账号、内网地址。
- **不出现成人内容**：Gallery 截图使用 `bookshop` 搜索过滤；桌面/手机相册条在某些截图中被临时隐藏，仅用于构图。
- **可复现**：截图来自本机运行实例（`http://127.0.0.1:7860/`），生成参数为 768×768、20 步、DPM++ 2M、CFG 7。

## 发布前检查

- [ ] 把 `assets/` 里的 20 张图按文章出现顺序上传到知乎。
- [ ] 用知乎的图片地址替换 Markdown 里的 `assets/...` 相对路径。
- [ ] 检查行内代码（`@PICK`、`outputs/`、`tag:`）在知乎编辑器里的显示。
- [ ] 标题保留“121 次提交”这一记忆点；如需要可改成更短的版本。
- [ ] 可选：在文末或评论区补 GitHub 仓库链接（正文暂未写，避免知乎外链限制）。
- [ ] 发布后把状态改为“已发布”，补上链接与日期。

## 可选的后续选题（未分配）

- Gallery v2 的迁移细节：双写、验收门、回滚。
- 单卡上的 sidecar 调度：显存、进程、队列。
- 提示词编辑器的设计：为什么行号改变了写作方式。
- 手机端为什么值得单独做一套前端。
- 从图库到 LoRA 训练集：Image Maker / LoRA Data Maker 流水线。
- Composer 与 Censor：把修图留在生成工具里。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-23 | 建立台账；完成单篇《半年、121 次提交》初稿与 20 张实机截图 |
