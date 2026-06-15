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

可选：

- `MAIL_CC`：抄送人。
- `SMTP_SECURE`：`true` 表示 SSL，通常端口 `465` 用 `true`，端口 `587` 用 `false`。
- `MAIL_SUBJECT`：固定邮件标题。不填时自动生成。
- `MAIL_TEXT`：固定邮件正文。不填时自动生成。

## 发送时间

默认是每周五 18:00 发送。GitHub Actions 的 cron 使用 UTC，所以配置为：

```yaml
cron: "0 10 * * 5"
```

如果要改成每周六 10:00，在 `.github/workflows/send-weekly-report.yml` 里改成：

```yaml
cron: "0 2 * * 6"
```

## 测试方式

先在 GitHub 仓库页面打开 `Actions` -> `Auto email weekly report` -> `Run workflow`。

第一次建议勾选 `dry_run`，它只生成附件，不发送邮件。确认附件没问题后，再取消 `dry_run` 手动运行一次。

注意：`dry_run` 会把生成的周报作为 GitHub Actions artifact 上传，公共仓库里不要用真实敏感数据长时间保留测试附件。

如果公司邮箱不允许 SMTP 登录，需要让 IT 开启 SMTP AUTH，或者改成 Microsoft Graph / 企业邮箱 API 发送。
