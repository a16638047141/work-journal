export default {
  async scheduled(controller, env) {
    const result = await triggerWeeklyReport(env, {
      source: "cron",
      scheduledTime: controller.scheduledTime,
    });
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

      const result = await triggerWeeklyReport(env, { source: "http" });
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
    },
  };

  const response = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "work-journal-cloudflare-timer",
      },
      body: JSON.stringify(body),
    },
  );

  return {
    ok: response.status === 204,
    status: response.status,
    repo,
    workflow,
    ref,
    trigger_source: triggerSource,
    source: meta.source,
    scheduled_time: meta.scheduledTime || null,
    triggered_at: new Date().toISOString(),
  };
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
