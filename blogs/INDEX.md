# A1111 改造手记 · 文章台账

> 一个持续半年的个人分叉：把 A1111 WebUI 从“生成表单”改造成“AI 绘画工作台”。
> 面向知乎发布。文章与截图都在 `blogs/`，本文件记录写了什么、图从哪来、发布前还要做什么。

## 文章信息

| 项 | 内容 |
|---|---|
| 标题 | 基于 A1111 的 WebUI 打造自用自改的 AI 生图工作流 |
| 文件 | [01-workbench-tour.md](01-workbench-tour.md) |
| 状态 | ✅ 完稿（待发布） |
| 平台 | 知乎（中文） |
| 体裁 | 人话部分（作者自述）+ AI部分（AI 整理的界面导览，图多） |
| 正文字数 | 约 5,400 汉字（人话部分约 1,250；AI部分约 4,150） |
| 截图 | 25 个（23 张 PNG + 2 张 GIF），见下方清单 |
| 封面 | [cover.png](assets/cover.png)（1200×675，16:9，知乎封面用，不嵌入正文） |
| 基线 | AUTOMATIC1111/stable-diffusion-webui v1.10.1（`82a973c`，2024-07-27） |
| 统计口径 | `git log master..dev`，2026-04-28 → 2026-10-23 |

## 进度

- 已完稿：1 篇
- 已发布：0 篇
- 截图：25 个（23 张 PNG + 2 张 GIF，全部来自本机运行中的实例）
- 封面：1 张（1200×675）
- 待办：把 `assets/` 里的 25 个图按顺序上传到知乎，替换 Markdown 的相对路径；封面单独上传

## 文章结构

### 人话部分（作者撰写，禁止改动）

1. 为什么要改造 WebUI：从“十分正经的 AI 生图测试”到被各种小需求驱动。
2. 三个生产力改动：TextEditor（txt → 拖拽复用 → DB → CodeMirror → 建议/块注释/`@PICK`）、Gallery（评分/stage/归档/删除/相册，v1→v2）、Composer（笔刷/线段/取色/图层/滤镜/改色，修手指再 inpaint）。
3. 最后的人话：收尾并引出 AI 部分。
4. 配图：TextEditor、Gallery、Composer 三个小节各 1 张实机截图；TextEditor 和 Gallery 另各配 1 张操作 GIF（只加图，不改文字）。

### AI部分（AI 整理，可修改）

1. **它现在是什么**：分叉基线、121 次提交 / 207 个文件 / +6.9 万行、十个页签、四段流水线；含“为什么是分叉，不是重写”。
2. **说得清**：提示词从 txt 缓存 → 拖拽复用 → 数据库 → CodeMirror 的演进；行号、行内/块注释、`@PICK`、输入建议。
3. **算得出**：sidecar 模式、Krea 2 / Qwen / Nano Banana、Job Queue、控制面与数据面分离。
4. **存得下**：Gallery v1→v2、权威库、blob 存储、来源注册表、状态机、FTS、迁移数字与双轨策略。
5. **用得上**：Composer / Censor / Inpaint、Mobile Lite 六屏与入口设置。
6. **代价与现状**：个人分叉的三条规矩、AI 辅助下“能跑”和“对”的区别、上游维护成本。
7. **功能清单**：把现有能力压成一张清单。
8. **接下来**：继续打磨的方向与收尾。

## 封面

`assets/cover.png`，1200×675（16:9），用于知乎文章封面，不嵌入正文。

- 主标题：自用自改的 / AI 生图工作台
- 副标题：从 TextEditor 到 Gallery v2，再到 Composer 与 Mobile Lite。
- 角标：A1111 v1.10.1 · PERSONAL FORK
- 数字：121 commits / 207 files / 6 months
- 视觉：Composer 主卡 + TextEditor / Gallery / Mobile Lite 副卡，全部来自实机截图。

## 截图清单

| 文件 | 展示内容 | 用在哪一节 | 备注 |
|---|---|---|---|
| `assets/21-texteditor-block.png` | CodeMirror：行号、块注释、行内 `#(...)`、`@PICK` | 人话部分 · TextEditor | 2026-10-23 新增 |
| `assets/text-editor-demo.gif` | TextEditor 操作：逐行输入、块注释、`@PICK`、`Ctrl+/` 注释与撤销 | 人话部分 · TextEditor | 9 帧，约 262 KB |
| `assets/22-gallery-actions.png` | 详情面板：评分/stage/归档/回收站/相册/send-to | 人话部分 · Gallery | 2026-10-23 新增 |
| `assets/workflow-gallery-to-composer.gif` | 图库 → 详情 → Composer → 手绘一笔 | 人话部分 · Gallery | 4 帧，约 485 KB |
| `assets/23-composer-brush.png` | Composer：画笔/取色/工具/输出（含一笔演示） | 人话部分 · Composer | 2026-10-23 新增 |
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
- **人话部分只加图**：21/22/23 与 2 张 GIF 是插入到人话部分三个小节的实机截图/录屏，未改动任何原文。
- **GIF 为实机截帧**：TextEditor 9 帧、工作流 4 帧，均由运行中的实例逐帧截图合成；未加速、未拼接别的素材。
- **不出现密钥**：Nano Banana 截图裁掉了 API Key 行；任何截图都不要包含密钥、账号、内网地址。
- **不出现成人内容**：Gallery 截图使用 `bookshop` 搜索过滤；桌面/手机相册条在某些截图中被临时隐藏，仅用于构图。
- **可复现**：截图来自本机运行实例（`http://127.0.0.1:7860/`），生成参数为 768×768、20 步、DPM++ 2M、CFG 7。

## 写作边界

- `## 人话部分` 的**文字**由作者撰写，不得改动；可以在小节之间插入截图（本次插入了 21/22/23），但不要改字。
- AI部分可以引用人话部分的观点和用例，但不要整段复述。
- 新增内容优先服务于“需求 → 工作流 → 重构”的叙事，而不是堆功能。

## 发布前检查

- [ ] 保留“人话部分”原样，不要合并、改写或润色。
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
| 2026-10-23 | 建立台账；完成单篇初稿与 20 张实机截图 |
| 2026-10-23 | 作者补入“人话部分”；AI部分按人话部分补充 TextEditor 演进、Gallery v1→v2、Composer 修手指用例与 AI 验证反思 |
| 2026-10-23 | 在“人话部分”的三个小节各插入 1 张实机截图（只加图，不改文字） |
| 2026-10-23 | 加入 2 张操作 GIF：TextEditor 逐行输入/注释演示、图库→Composer→手绘工作流 |
| 2026-10-23 | 生成 1200×675 知乎封面 `assets/cover.png`（实机截图拼贴 + 标题文案） |
