# 数物工作周报 Cloudflare 定时器

这个 Worker 用 Cloudflare Cron Triggers 触发 GitHub Actions 的 `workflow_dispatch`，替代 GitHub 自带 `schedule`。

## 配置

先准备一个 GitHub fine-grained token：

- Repository access：只选 `a16638047141/work-journal`
- Repository permissions：`Actions` 设为 `Read and write`

然后在本目录执行：

```powershell
npm install
npx wrangler login
npx wrangler secret put GITHUB_ACTIONS_TOKEN
```

## 测试定时

默认配置是周三 16:20 中国时间：

```jsonc
"crons": ["20 8 * * 3"]
```

部署测试版：

```powershell
npm run deploy
```

Cloudflare cron 使用 UTC，不是北京时间。`20 8 * * 3` 等于中国时间周三 16:20。

## 正式定时

正式环境配置在 `env.prod`，时间是每周六 08:07 中国时间：

```powershell
npm run deploy:prod
```

## 手动云端触发测试

部署后也可以临时调用：

```powershell
Invoke-WebRequest -Method Post https://<worker-url>/trigger
```

如果设置了 `TIMER_SHARED_SECRET`，调用时需要带：

```powershell
Invoke-WebRequest -Method Post https://<worker-url>/trigger -Headers @{ "X-Timer-Secret" = "你的密钥" }
```
