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

默认环境不设置定时任务，避免测试任务重复运行：

```jsonc
"crons": []
```

需要测试时可临时填写一个 UTC cron，然后部署默认环境。测试成功后应恢复为空数组：

```powershell
npx wrangler deploy --env=""
```

## 正式定时

正式环境配置在 `env.prod`，会在每周六 08:00、08:05、08:10 中国时间依次尝试。Cloudflare cron 使用 UTC：

```jsonc
"crons": ["0,5,10 0 * * 6"]
```

首次发送成功后，后续运行会由 Gist 发送历史自动跳过。单次调用遇到 HTTP 408、425、429 或 5xx 时，Worker 还会在内部重试最多三次。

```powershell
npm run deploy:prod
```

## 手动云端触发测试

当前配置关闭了 `workers.dev` 公网地址。如需临时调用 `/trigger`，先为 Worker 配置公开路由，再发送请求：

```powershell
Invoke-WebRequest -Method Post "https://<worker-url>/trigger?dry_run=true"
```

如果设置了 `TIMER_SHARED_SECRET`，调用时需要带：

```powershell
Invoke-WebRequest -Method Post https://<worker-url>/trigger -Headers @{ "X-Timer-Secret" = "你的密钥" }
```
