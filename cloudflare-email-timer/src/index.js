export default {
  async scheduled(controller, env) {
    const result = await triggerWeeklyReport(env, {
      source: "cron",
      scheduledTime: controller.scheduledTime,
      dryRun: isTruthy(env.DRY_RUN),
    });
    if (!result.ok) {
      console.error(JSON.stringify(result));
      throw new Error(`GitHub workflow dispatch failed: HTTP ${result.status}`);
    }
    console.log(JSON.stringify(result));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "work-journal-email-timer" });
    }

    if (url.pathname === "/trigger" && request.method === "POST") {
      const configuredSecret = env.TIMER_SHARED_SECRET || "";
      if (configuredSecret) {
        const providedSecret = request.headers.get("X-Timer-Secret") || "";
        if (providedSecret !== configuredSecret) {
          return json({ ok: false, error: "unauthorized" }, 401);
        }
      }

      const result = await triggerWeeklyReport(env, {
        source: "http",
        dryRun: isTruthy(url.searchParams.get("dry_run")),
      });
      return json(result, result.ok ? 200 : 502);
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};

async function triggerWeeklyReport(env, meta) {
  const repo = required(env, "GITHUB_REPO");
  const workflow = required(env, "GITHUB_WORKFLOW");
  const ref = env.GITHUB_REF || "main";
  const token = required(env, "GITHUB_ACTIONS_TOKEN");
  const triggerSource = env.TRIGGER_SOURCE || "timer";

  const body = {
    ref,
    inputs: {
      trigger_source: triggerSource,
      dry_run: Boolean(meta.dryRun),
    },
  };

  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;
  let response;
  let attempts = 0;

  while (attempts < 3) {
    attempts += 1;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "work-journal-cloudflare-timer",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (attempts >= 3) throw error;
      await delay(attempts * 1000);
      continue;
    }

    if (response.status === 204 || !isRetryableStatus(response.status)) break;
    await delay(attempts * 1000);
  }

  return {
    ok: response.status === 204,
    status: response.status,
    attempts,
    repo,
    workflow,
    ref,
    trigger_source: triggerSource,
    dry_run: Boolean(meta.dryRun),
    source: meta.source,
    scheduled_time: meta.scheduledTime || null,
    triggered_at: new Date().toISOString(),
  };
}

function isTruthy(value) {
  return /^(1|true|yes|y)$/i.test(String(value || "").trim());
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function required(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required binding: ${name}`);
  }
  return value;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
