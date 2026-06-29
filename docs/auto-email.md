# 周报自动邮件发送

这个功能用 GitHub Actions 定时读取你的 Gist 数据，生成和网页导出一致的周报 Excel，然后通过公司邮箱 SMTP 发出。

## 需要配置的 GitHub Secrets

进入仓库 `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`，添加：

- `WORK_JOURNAL_GIST_ID`：网页里复制出来的 Gist ID。
- `WORK_JOURNAL_GIST_TOKEN`：有 `gist` 权限的 GitHub Token，用来读取同步数据。
- `SMTP_HOST`：公司邮箱 SMTP 地址。
- `SMTP_PORT`：SMTP 端口，常见是 `465` 或 `587`。
- `SMTP_USER`：发件邮箱账号。
- `SMTP_PASS`：邮箱授权码或 SMTP 密码。
- `MAIL_FROM`：发件人，例如 `袁宏林 <name@company.com>`。
- `MAIL_TO`：收件人，多个邮箱用英文逗号分隔。

你的企业邮箱域名 `shuwutech.cn` 当前 MX 指向腾讯企业邮箱，通常可以先按下面配置：

- `SMTP_HOST`：`smtp.exmail.qq.com`
- `SMTP_PORT`：`465`
- `SMTP_SECURE`：`true`
- `SMTP_USER`：`yuanhonglin@shuwutech.cn`
- `MAIL_FROM`：`袁宏林 <yuanhonglin@shuwutech.cn>`

`SMTP_PASS` 不建议填网页登录密码，优先使用企业邮箱里的客户端专用密码/授权码。如果公司关闭了 SMTP，需要让管理员开启。

可选：

- `MAIL_CC`：抄送人。
- `SMTP_SECURE`：`true` 表示 SSL，通常端口 `465` 用 `true`，端口 `587` 用 `false`。
- `MAIL_SUBJECT`：固定邮件标题。不填时自动生成。
- `MAIL_TEXT`：固定邮件正文。不填时自动生成。

## 发送时间

正式发送由 Cloudflare Worker 在云端触发，不依赖电脑开机。当前会在每周六北京时间 08:00、08:05、08:10 依次尝试；Cloudflare cron 使用 UTC，星期字段用 `SAT`，避免 Cloudflare 的数字星期规则造成误解：

```jsonc
"crons": ["0,5,10 0 * * SAT"]
```

自动发送前会检查 Gist 里的发送历史。首次发送成功后，后续两个时间点会自动跳过；如果本周已经在周五通过网页按钮手动发送过，周六的自动发送也会直接跳过，避免重复发同一份周报。Worker 调用 GitHub 遇到临时 HTTP 错误时会在内部重试最多三次，最终失败会明确记录为错误。

Cloudflare 触发 GitHub Actions 的 `workflow_dispatch`，并传入 `trigger_source=timer`。脚本会按周记录 `timer` 发送历史，同一周重复触发时会自动跳过。

定时器配置位于 `cloudflare-email-timer/`。默认测试环境不设 Cron，正式环境使用 `env.prod`；GitHub 工作流本身只保留手动接口，不再使用 GitHub 原生 `schedule`。

如果要改成每周六 10:00，在 `cloudflare-email-timer/wrangler.jsonc` 的 `env.prod.triggers` 中改成：

```jsonc
"crons": ["0,5,10 2 * * SAT"]
```

## 测试方式

先在 GitHub 仓库页面打开 `Actions` -> `Auto email weekly report` -> `Run workflow`。

第一次建议勾选 `dry_run`，它只生成附件，不发送邮件。确认附件没问题后，再取消 `dry_run` 手动运行一次。

注意：`dry_run` 会把生成的周报作为 GitHub Actions artifact 上传，公共仓库里不要用真实敏感数据长时间保留测试附件。

## 网页里手动发送

HTML 里有 `邮件发送` 区域，可以填写收件人、抄送并点击 `手动发送周报`。这个按钮不会直接登录企业邮箱，而是触发 GitHub Actions，由 GitHub 用 Secrets 里的 SMTP 配置发出。

第一次点击前需要设置一个 GitHub Token：

- Fine-grained token：只选择 `a16638047141/work-journal` 仓库，`Actions` 设为 `Read and write`，`Contents` 设为 `Read-only`。
- Classic token：需要 `repo` 和 `workflow` 权限。

这个 Token 只保存在当前浏览器的 localStorage，不会写入 Gist，也不会推到 GitHub。

如果公司邮箱不允许 SMTP 登录，需要让 IT 开启 SMTP AUTH，或者改成 Microsoft Graph / 企业邮箱 API 发送。
