# AI Morning Post

把 [AI Morning Post RSS](https://daily.juya.uk/rss.xml) 整理成适合邮件阅读的 HTML/纯文本日报。原型是私有、维护者手工管理收件人列表的 CLI 服务，不开放网页订阅，也不调用大模型二次改写内容。

## 原型工作流

```text
RSS --15 分钟轮询--> SQLite 去重/记录 --渲染--> QQ Mail SMTP --逐个收件人--> 日报
```

首次 `fetch` 只记录当前 RSS 期刊，不会追发历史内容；验收邮件使用独立的 `send-test`，之后由定时 `run` 处理新一期。数据库唯一约束避免同一期刊重复发送。

## 本地运行

需要 Node.js 24 或更新版本。

```bash
npm ci
cp config.example.toml config.toml
npm run build

# 预览不会连接 SMTP，也不会写入发送记录
node dist/cli.js --config config.toml preview
node dist/cli.js --config config.toml send-test yceachan@foxmail.com
node dist/cli.js --config config.toml run --dry-run
```

维护者收件人只通过 CLI 管理。原型的第一个收件人是：

```bash
node dist/cli.js --config config.toml subscriber add yceachan@foxmail.com
node dist/cli.js --config config.toml subscriber list
node dist/cli.js --config config.toml smtp verify
```

每个收件人可以独立配置接收星期；未指定时默认为 `everyday`：

```bash
# 周一到周五
node dist/cli.js --config config.toml subscriber add work@example.com --days work

# 修改已有收件人：仅周六、周日
node dist/cli.js --config config.toml subscriber schedule work@example.com weekend

# 自定义周一到周日：1 表示接收，0 表示跳过
node dist/cli.js --config config.toml subscriber schedule work@example.com "7b'10101_10"
```

数据库使用一个整数掩码的低七位，从高到低依次表示周一至周日：`11111_11` 是 `everyday`，`11111_00` 是 `work`，`00000_11` 是 `weekend`，第八位保留。筛选使用 `Asia/Singapore` 当天日期，只在新期刊首次建立投递记录时执行；不符合当天配置的期刊会跳过，不会延迟到下一个接收日。已经建立的 pending/failed 投递会继续重试，不因跨日而丢失。

`preview` 和 `send-test EMAIL` 都会基于数据库中的 RSS 原文，使用当前代码即时渲染，不读取 `rendered_html` 缓存；测试邮件不会创建或修改投递记录，可以反复验收。`run` 是唯一的定时/正式推送入口，继续使用投递记录完成去重和失败重试。

模板升级后可手工执行 `node dist/cli.js --config config.toml rerender`，在单个事务中重建所有历史期刊的 `rendered_html` / `rendered_text`，不会改动订阅者或投递记录。`deploy/install.sh` 在正常构建后会自动执行这一步。

常用命令还包括 `fetch`、`smtp verify`、`rerender`、`send-test EMAIL`、`run`、`subscriber remove EMAIL`。执行 `node dist/cli.js --help` 查看当前版本的完整帮助。

## 为什么原型仍保留 SQLite

SQLite 的核心价值不是缓存邮件 HTML，而是保存定时任务必须共享的少量状态：RSS 的 ETag、期刊 GUID 去重、收件人名单，以及每个“期刊 × 收件人”的 pending/sent/failed 投递账本。没有这层持久状态，15 分钟轮询、进程中断和 SMTP 临时失败很容易造成漏发或重复发送。

因此现阶段保留单文件 SQLite，比把同样的状态拆成 JSON、锁文件和发送标记更简单可靠。`rendered_html` / `rendered_text` 只是可重建的派生缓存，不是数据库存在的理由；测试入口已经不再读取它们，部署时也会统一刷新。若原型以后改成“仅一个固定收件人、允许偶尔重复、无失败重试”，才适合连同投递账本一起移除数据库。

## QQ 邮箱发件机器人

配置 QQ 邮箱 SMTP：服务器 `smtp.qq.com`，端口 `465`，SSL/TLS 开启，用户名使用完整邮箱地址 `yceachan@qq.com`。密码必须是 QQ 邮箱设置中生成的 16 位 SMTP 授权码，不是 QQ 登录密码；修改 QQ 密码后需要重新生成授权码。QQ 官方说明见[帮助文档](https://help.mail.qq.com/detail/106/985)。

认证值不要写入 Git 或提交到 `config.toml`。在服务器的 `~/.profile` 中提供环境变量，并把文件权限设为仅自己可读：

```bash
export QQ_SMTP_USERNAME='yceachan@qq.com'
export QQ_SMTP_AUTH_CODE='在 QQ 邮箱生成的 16 位授权码'
chmod 600 ~/.profile
```

`config.toml` 只保留 `$QQ_SMTP_USERNAME`、`$QQ_SMTP_AUTH_CODE` 等引用；程序支持 `$NAME` 和 `${NAME}`。`scripts/run-job.sh` 被 cron/systemd 调用时会显式加载 `~/.profile`，profile 应只包含可由 Bash/POSIX shell 执行的 `export` 声明。更严格的生产环境可把这些变量改放在仅当前用户可读的独立 `EnvironmentFile`，再让调度器加载。

wrapper 会把 `~/.local/bin` 和 `~/bin` 加入非交互服务的 `PATH`，因此通过这些目录安装的 Node 在 cron 和 systemd 中都可用。

在登录 shell 没有自动加载 `~/.profile` 的环境中，可以通过同一个安全 wrapper 执行管理命令：

```bash
scripts/run-job.sh smtp verify
scripts/run-job.sh send-latest
```

## VPS 部署

目标目录为 `~/work/Ai-Morning-Post`。在 VPS 上执行：

```bash
cd ~/work/Ai-Morning-Post
git pull --ff-only
bash deploy/install.sh --dry-run
bash deploy/install.sh

# 仅首次执行；之后重复执行会保留已有 config.toml 和数据库
node dist/cli.js --config config.toml subscriber add yceachan@foxmail.com
node dist/cli.js --config config.toml preview
node dist/cli.js --config config.toml send-test yceachan@foxmail.com
node dist/cli.js --config config.toml run --dry-run
```

安装脚本会安装依赖、构建程序、创建 `data/`、`logs/`、`backups/`，并把无密钥的 `deploy/config.toml.example` 首次复制为权限 `600` 的 `config.toml`。它不会覆盖已有配置，不会读取或提交授权码，也不会改变不带 `ai-morning-post managed cron` 标记的 crontab 行。

当前 VPS 的 user-systemd linger 未开启，因此默认使用当前用户的单条 crontab，每 15 分钟执行一次：

```bash
crontab -l
tail -f ~/work/Ai-Morning-Post/logs/cron.log
```

安装是幂等的，重复运行只保留一条带 marker 的任务。若管理员执行：

```bash
sudo loginctl enable-linger "$USER"
```

之后可以切换到 user-systemd timer：

```bash
bash deploy/install.sh --scheduler systemd
systemctl --user status ai-morning-post.timer
journalctl --user -u ai-morning-post.service -f
```

模板位于 `deploy/systemd/`，service 使用同一个 profile-loading wrapper，timer 周期为 15 分钟。

## 备份、日志与回滚

每次升级前建议执行：

```bash
scripts/backup.sh
```

备份默认为 `backups/newsletter-<UTC>.sqlite3`，保留 14 天；可用 `AI_MORNING_POST_DB` 和 `AI_MORNING_POST_BACKUP_KEEP_DAYS` 覆盖数据库路径和保留期。cron 日志在 `logs/cron.log`；systemd 模式使用 `journalctl --user` 查看。

代码回滚采用可审计的 Git 提交，不使用 `reset --hard`：

```bash
git log --oneline -5
git revert --no-edit <出问题的提交>
npm ci && npm run build
bash deploy/install.sh --skip-build
```

如果需要恢复数据库，先停用 cron/timer，保留当前数据库副本，再从 `backups/` 中选择备份用 SQLite 工具恢复；确认 `preview` 和 `subscriber list` 正常后再重新启用调度。不要把 `config.toml`、SQLite 文件、日志或授权码提交到 Git。

## 开源与 CI

项目使用 MIT License。GitHub Actions 在 Node 24 上执行依赖安装、lint/typecheck（如果项目提供）、测试和构建；工作流不需要 SMTP secrets，也不会发送邮件。
