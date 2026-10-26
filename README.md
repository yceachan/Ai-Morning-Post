# AI Morning Post

面向个人和小型私有名单的邮件订阅服务：把 [AI Morning Post RSS](https://daily.juya.uk/rss.xml) 转成适合邮箱阅读的早报，并可通过 [Codex Resets API](https://codex-resets.com/api/docs) 发送 Codex 重置公告。维护者通过 CLI 管理用户，服务按约 15 分钟的周期检查更新，使用同一个 SMTP 邮箱逐个投递。

导航：[能力范围](#能力范围) · [首次部署](#首次部署) · [用户列表维护](#用户列表维护) · [运维命令](#运行与运维命令) · [备份恢复](#数据备份与恢复) · [升级回滚](#升级与回滚)

## 能力范围

| 能力 | 当前行为 |
| --- | --- |
| 早报邮件 | 抓取 RSS，生成 HTML 与纯文本正文；保留原文内容、链接和来源，清理脚本等活动内容 |
| 阅读模式 | `full` 保留正文及图片；`compact` 保留文字，移除图片和图片画廊 |
| 用户管理 | 添加、停用、重新启用邮箱；为每个用户设置每天、工作日、周末或自定义星期 |
| Codex 重置通知 | 可选启用，支持常规重置与备用重置额度（banked）；通知明确公布的计划及计划时间变化 |
| 投递管理 | SQLite 保存期刊、订阅者、查询进度和投递记录；成功记录去重，pending/failed 记录在后续轮询重试 |
| 验收与预览 | 本地预览早报；独立发送带 `[TEST]` 标记的早报或重置测试邮件 |
| 部署 | Linux、Node.js 24+，支持 user-systemd timer 或用户 crontab |

邮件由同一邮箱发送，通过显示名称和主题区分：

| 邮件类型 | 发件人显示名称 | 主题 |
| --- | --- | --- |
| 早报 | `[email].from_name`，默认 `AI Morning Post` | 默认 `[AI Morning Post] <期刊标题>` |
| Codex 重置 | 固定 `Codex Reset Plan` | `[Codex Resets] <通知标题>` |

两类邮件共用 `[email].from` 和 SMTP 认证账号。重置通知采用 API 返回的公告原文；X 来源以适合邮件的静态帖子卡片展示。邮件时间和早报接收星期统一采用 **Asia/Singapore（UTC+8）**。

服务定位为单维护者管理的私有 CLI。订阅和退订由维护者操作，内容直接来自订阅源，邮件模板在本地渲染。早报在发现新期刊后发送，实际时间取决于源站更新和下一次轮询；`everyday` 表示每天都有接收资格。

## 首次部署

以下命令在目标 Linux 用户下执行。默认目录为 `~/work/Ai-Morning-Post`，systemd 模板也使用这个路径。

### 1. 准备运行环境与代码

准备 Git、Bash、Node.js 24+、npm 和 `flock`。服务器需要能够访问 RSS、Codex Resets API（启用重置通知时）以及 SMTP 服务。

```bash
node --version
npm --version
command -v flock

mkdir -p ~/work
git clone https://github.com/yceachan/Ai-Morning-Post.git ~/work/Ai-Morning-Post
cd ~/work/Ai-Morning-Post

npm ci
npm run build
install -d -m 700 data logs backups
cp config.example.toml config.toml
chmod 600 config.toml
```

已有部署的更新步骤见[升级与回滚](#升级与回滚)。

### 2. 配置发件邮箱

编辑 `~/.profile`，保留原有内容并加入：

```bash
export QQ_SMTP_USERNAME='your-bot@qq.com'
export QQ_SMTP_AUTH_CODE='你的QQ邮箱SMTP授权码'
```

```bash
chmod 600 ~/.profile
```

QQ 邮箱配置为 `smtp.qq.com:465`、SSL/TLS，密码填写邮箱设置中生成的 SMTP 授权码。授权码获取方法见 [QQ 邮箱帮助](https://help.mail.qq.com/detail/106/985)。

编辑 `config.toml`：

```toml
[feed]
url = "https://daily.juya.uk/rss.xml"

[database]
path = "data/ai-morning-post.sqlite"

[resets]
enabled = false

[email]
host = "smtp.qq.com"
port = 465
secure = true
username = "$QQ_SMTP_USERNAME"
password = "$QQ_SMTP_AUTH_CODE"
from = "$QQ_SMTP_USERNAME"
from_name = "AI Morning Post"
subject_prefix = "AI Morning Post"
mode = "full"
```

需要重置通知时，把 `[resets].enabled` 改为 `true`。早报版式可选 `full` 或 `compact`；历史期刊的版式更新通过 `rerender` 完成。

环境变量引用支持完整的 `$NAME` 和 `${NAME}`。数据库相对路径以配置文件所在目录为基准。`config.toml`、授权码和运行数据库均由部署用户本地保存，Git 已配置忽略这些文件。

生产命令统一使用 `scripts/run-job.sh`：它加载 `~/.profile`、补齐 `~/.local/bin` 与 `~/bin` 的 PATH，并通过 `data/run.lock` 避免定时任务与手工命令并发运行。`~/.profile` 中的配置应可由 Bash 执行，加载失败会终止本次任务。

### 3. 初始化名单、历史基线与验收

将示例邮箱换成实际收件人：

```bash
scripts/run-job.sh subscriber add reader@example.com --days everyday
scripts/run-job.sh subscriber list
scripts/run-job.sh smtp verify

# 首次抓取：把现有 RSS 期刊入库，作为历史基线
scripts/run-job.sh fetch

# 预览已有最新期刊，并发送一封早报测试邮件
scripts/run-job.sh preview --text
scripts/run-job.sh send-test reader@example.com
```

`fetch` 负责入库，测试邮件走独立验收入口。完成这组初始化后，定时任务会投递以后发现的新期刊。如果从空库直接执行 `run`，该轮会选择 RSS 最新一期向符合当天设置的用户正式投递。

启用重置通知且 API 存在当前计划时，还可预览或发送计划快照：

```bash
scripts/run-job.sh resets send-test --dry-run
scripts/run-job.sh resets send-test
```

重置测试收件人固定为 **yceachan@foxmail.com**，由源码中的 `RESET_TEST_RECIPIENT` 定义。两个测试入口都带 `[TEST]`，保持正式投递记录原状。重置测试使用当前计划；API 没有计划时，命令会提示当前无计划并退出。

### 4. 启用定时任务

**user-systemd（当前 VPS 使用此方式）**

为部署用户开启退出登录后继续运行的能力。在部署用户会话中执行一次（需管理员权限）：

```bash
sudo loginctl enable-linger "$USER"
```

部署用户执行：

```bash
bash deploy/install.sh --scheduler systemd --dry-run
bash deploy/install.sh --scheduler systemd

systemctl --user status ai-morning-post.timer
systemctl --user list-timers ai-morning-post.timer
```

timer 配置为开机后约 5 分钟触发，后续周期约 15 分钟；启用时若已超过开机触发时间，可能立即运行。service 每次执行一轮 `poll`。

**用户 crontab**

```bash
bash deploy/install.sh --scheduler cron --dry-run
bash deploy/install.sh --scheduler cron
crontab -l
```

cron 使用带 `ai-morning-post managed cron` 标记的单条 `*/15` 任务；不指定 `--scheduler` 时，安装器默认选择 cron。

两种调度方式择一启用。由 cron 切换到 systemd 时，先通过 `crontab -e` 删除上述标记行；反向切换时，先执行 `systemctl --user disable --now ai-morning-post.timer`。安装器只管理所选调度器，保留另一种调度器的已有配置。

安装器会安装依赖、构建、创建权限为 `700` 的运行目录，并重建历史邮件渲染缓存；已有 `config.toml`、订阅者及投递记录会保留。配置文件缺失时从 `deploy/config.toml.example` 创建。已完成构建和缓存重建时，可添加 `--skip-build`。

## 用户列表维护

登录服务器后，以下命令均在项目目录执行：

```bash
ssh vps
cd ~/work/Ai-Morning-Post
```

```bash
# 查看启用用户；--all 同时显示已停用用户
scripts/run-job.sh subscriber list
scripts/run-job.sh subscriber list --all

# 新增或重新启用，并明确设置每天接收
scripts/run-job.sh subscriber add reader@example.com --days everyday

# 修改接收日期
scripts/run-job.sh subscriber schedule reader@example.com work
scripts/run-job.sh subscriber schedule reader@example.com weekend
scripts/run-job.sh subscriber schedule reader@example.com everyday

# 自定义：周一、周三、周五、周六接收
scripts/run-job.sh subscriber schedule reader@example.com "7b'10101_10"

# 停用，保留用户及其历史投递记录
scripts/run-job.sh subscriber remove reader@example.com
```

| 日期设置 | 接收星期 | 掩码 |
| --- | --- | --- |
| `everyday` | 周一至周日 | `11111_11` |
| `work` | 周一至周五 | `11111_00` |
| `weekend` | 周六、周日 | `00000_11` |
| `"7b'10101_10"` | 周一、周三、周五、周六 | 从左至右依次对应周一至周日，1 表示接收 |

新增用户省略 `--days` 时采用 `everyday`；已有用户省略该参数时保留原接收日期，并恢复启用状态。`schedule` 修改已存在用户的日期，用户是否启用仍由 `add` / `remove` 控制。邮箱会去除首尾空格并统一为小写。

早报在发现新期刊、首次建立投递任务时按当天星期筛选收件人。不符合当天配置的期刊直接跳过；已建立的 pending/failed 投递跨日继续重试。新增用户参与之后新建的投递任务，历史早报验收使用 `send-test EMAIL`。

启用 Codex 重置通知后，**全部有效订阅者**都会收到新重置公告，早报星期设置只作用于早报。停用邮箱同时停止其早报和重置通知。

## 运行与运维命令

### 轮询与投递

```bash
# 与定时任务相同：按配置检查重置公告，再处理早报
scripts/run-job.sh poll

# 单独处理早报：抓取新期刊，并重试已有 pending/failed 投递
scripts/run-job.sh run

# 单独处理 Codex 重置公告
scripts/run-job.sh resets run
```

`[resets].enabled` 控制 `poll` 是否执行重置任务；显式调用 `resets run` 会直接运行该任务。`poll` 中任一任务失败后仍会执行另一项，最终通过非零退出码报告故障。

重置任务查询 `GET /api/v1/status` 中的 `data.scheduled_reset`。首次发现有效计划即建立投递任务，后续按计划 ID 和 `scheduled_for` 去重；计划时间调整后再次通知。正式邮件统一使用 `[Codex Resets] Codex 重置计划已公布`，常规重置与备用重置额度计划均适用。执行记录 `latest_reset`、历史执行接口及 `active_watch` 概率预测均在推送范围之外；旧版本留下的执行消息投递记录保留存档，后续重试仅处理计划消息。

查询失败时，已有计划待投递任务仍会重试；成功读取当前计划后才提交查询进度。早报抓取成功后处理其新任务和重试任务，抓取失败时保留记录，等待后续轮询恢复。

### 预览、测试与 dry-run

```bash
scripts/run-job.sh preview                 # 输出最新早报 HTML
scripts/run-job.sh preview --text          # 输出纯文本
scripts/run-job.sh send-test reader@example.com
scripts/run-job.sh send-test reader@example.com --dry-run

scripts/run-job.sh resets send-test --dry-run
scripts/run-job.sh resets send-test
scripts/run-job.sh resets run --dry-run
```

| 命令 | 输出或行为 | 状态变化 |
| --- | --- | --- |
| `preview` | 用当前模板渲染最新早报 | 有期刊时读取原文；空库时先抓取入库 |
| `send-test EMAIL` | 把最新早报发往指定邮箱 | 保持正式投递记录原状；需要已有期刊 |
| `send-test EMAIL --dry-run` | 检查期刊与渲染流程，输出目标邮箱 | 保持正式投递记录原状，跳过 SMTP |
| `resets send-test --dry-run` | 查询 API 并输出当前计划邮件文本 | 保持查询进度及正式投递记录原状 |
| `resets run --dry-run` | 查询可发现的重置事件数量 | 保持查询进度及正式投递记录原状 |
| `run --dry-run` | 抓取 RSS 并报告待处理期刊数、当天合格用户数 | **更新 RSS 状态并保存新期刊**，跳过投递建单与 SMTP |
| `poll --dry-run` | 对两个任务分别执行 dry-run | 早报部分具有上一行所述入库行为 |

早报 dry-run 会提前记录新发现的期刊。要在正式发送前模拟完整抓取，请使用独立数据库副本；正式库中的内容验收优先使用 `preview` 和 `send-test`。同理，`fetch` 适合初始化历史基线或有意手工入库，日常自动投递使用 `poll`。

手工命令输出 `another run is active; skipping` 时，表示本次因文件锁退出，待当前任务完成后重新执行。

### 日志与服务管理

systemd：

```bash
systemctl --user status ai-morning-post.service
systemctl --user list-timers ai-morning-post.timer
journalctl --user -u ai-morning-post.service -n 100 --no-pager
journalctl --user -u ai-morning-post.service -f

# 通过 service 立即运行一轮
systemctl --user start ai-morning-post.service

# 暂停 / 恢复后续定时触发
systemctl --user stop ai-morning-post.timer
systemctl --user start ai-morning-post.timer
```

停止 timer 后，已启动的一轮任务会继续完成。cron 部署查看 `logs/cron.log`；暂停或恢复 cron 通过 `crontab -e` 修改对应标记行。

```bash
tail -n 100 logs/cron.log
tail -f logs/cron.log
```

| 现象 | 检查与处理 |
| --- | --- |
| SMTP 配置或认证失败 | 检查 `~/.profile` 的变量，再运行 `scripts/run-job.sh smtp verify`；QQ 授权码更新后重试 |
| RSS / API 请求失败 | 查看 service journal 或 cron 日志中的 HTTP / 网络错误，恢复连接后执行对应任务 |
| 用户当天没有早报 | 检查是否有新期刊、用户是否 active、当天是否符合日期设置，以及该期刊是否已建立投递记录 |
| 新增用户需要看最新一期 | 执行 `scripts/run-job.sh send-test EMAIL` |
| 模板或模式变更后需要刷新正式邮件缓存 | 执行 `scripts/run-job.sh rerender` 重建正式发送缓存；预览与测试始终使用当前模板 |
| timer 正常而任务失败 | 查看 service 日志和退出码；timer 的启用状态与单次任务结果分别检查 |

### 命令入口与路径覆盖

查看完整 CLI 帮助：

```bash
scripts/run-job.sh --help
```

wrapper 支持用环境变量指定项目、入口和配置路径：

```bash
AI_MORNING_POST_CONFIG=/absolute/path/config.toml scripts/run-job.sh subscriber list
```

对应变量为 `AI_MORNING_POST_DIR`、`AI_MORNING_POST_ENTRY` 和 `AI_MORNING_POST_CONFIG`。需要直接调用 CLI 时，全局参数放在命令之前：

```bash
node dist/cli.js --config config.toml --db /absolute/path/review.sqlite preview --text
```

直接调用由当前 shell 提供环境变量与并发控制，生产环境沿用 wrapper。systemd 模板固定使用默认项目路径；自定义安装目录时同步修改 unit 的 `WorkingDirectory` 与 `ExecStart`。

## 数据、备份与恢复

SQLite 默认位于 `data/ai-morning-post.sqlite`，保存订阅者、期刊原文、RSS 条件请求状态、邮件渲染缓存，以及早报和重置投递账本。渲染缓存可以从原文重建；名单、查询进度与投递账本通过数据库备份恢复。

在所有生产命令统一使用 wrapper 的前提下，持有同一把锁执行备份：

```bash
flock data/run.lock scripts/backup.sh
```

有 `sqlite3` CLI 时，脚本通过 SQLite 在线备份接口生成一致快照；精简环境中使用文件复制，上述锁会等待当前任务释放数据库后再备份。默认输出 `backups/newsletter-<UTC时间>.sqlite3`，文件权限为 `600`，保留 14 天。

数据库路径或保留期自定义时，显式传给备份脚本：

```bash
AI_MORNING_POST_DB=/absolute/path/newsletter.sqlite \
AI_MORNING_POST_BACKUP_KEEP_DAYS=30 \
flock data/run.lock scripts/backup.sh
```

备份目录可通过 `AI_MORNING_POST_BACKUP_DIR` 覆盖。备份脚本按自己的路径设置寻找数据库；使用自定义 `[database].path` 时，应同时设置 `AI_MORNING_POST_DB`。发件配置和 `~/.profile` 中的凭据另行保存在私有备份中。

恢复时先暂停所用调度器，等待当前任务完成，并保留现状快照。以下是默认路径下的 systemd 恢复示例，把文件名换成选定备份：

```bash
systemctl --user stop ai-morning-post.timer

flock data/run.lock bash -c '
  set -e
  scripts/backup.sh
  cp "backups/newsletter-<UTC时间>.sqlite3" data/ai-morning-post.sqlite
  chmod 600 data/ai-morning-post.sqlite
  node dist/cli.js --config config.toml subscriber list --all
'

scripts/run-job.sh preview --text
```

恢复旧快照会同时回退投递账本和查询进度。重新启用轮询前，核对快照之后已经成功发送的邮件，评估恢复后可能再次投递的范围。确认后恢复定时触发：

```bash
systemctl --user start ai-morning-post.timer
```

## 升级与回滚

当前 VPS 使用 systemd。升级先暂停后续触发，在文件锁内备份、更新代码并安装：

```bash
cd ~/work/Ai-Morning-Post
systemctl --user stop ai-morning-post.timer

flock data/run.lock bash -c '
  set -e
  scripts/backup.sh
  git pull --ff-only
  bash deploy/install.sh --scheduler systemd
'

systemctl --user status ai-morning-post.timer
scripts/run-job.sh subscriber list
scripts/run-job.sh preview --text
```

安装器完成依赖安装、构建和历史缓存重建后启用 timer。升级中途失败时，修复对应错误并重新执行安装步骤。cron 部署采用相同的备份与更新顺序，维护期间先暂停标记行，安装参数改为 `--scheduler cron`。

代码回滚使用可审计的 `git revert`。沿用上述暂停调度、文件锁与备份步骤，把 `COMMIT_SHA` 换成需要撤销的提交，在锁内执行：

```bash
git log --oneline -5
git revert --no-edit COMMIT_SHA
bash deploy/install.sh --scheduler systemd
```

代码回滚会重新构建并刷新渲染缓存；数据库恢复按上一节单独选择快照。日常模板变更也可手工执行：

```bash
scripts/run-job.sh rerender
```

该操作在单个事务内重建所有历史期刊的 HTML / 纯文本缓存，保留订阅者和投递记录。

## 开发与仓库结构

```bash
npm ci
npm run typecheck
npm test
npm run build
```

GitHub Actions 在 Node.js 24 上执行依赖安装、类型检查、测试和构建。测试采用临时数据库和模拟投递，CI 使用仓库代码完成验证。

| 路径 | 职责 |
| --- | --- |
| `src/cli.ts` | 命令入口、早报及重置任务调度、发信类型选择 |
| `src/rss.ts` / `src/render.ts` | 订阅源抓取、内容清理和邮件渲染 |
| `src/db.ts` / `src/schedule.ts` | SQLite 状态、用户与接收日期 |
| `src/mailer.ts` | SMTP、早报投递及测试邮件 |
| `src/resets.ts` / `src/x-post.ts` | 重置事件发现、去重、投递和静态帖子卡片 |
| `scripts/` | 带锁运行入口及数据库备份 |
| `deploy/` | 安装器、配置模板和 systemd units |
| `test/` | 早报、用户日期、重置通知等行为验证 |

项目采用 [MIT License](LICENSE)。
