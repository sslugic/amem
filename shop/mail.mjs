let client;

export function mailFromAddress(env = process.env) {
  return (
    env.AMEM_FROM_EMAIL ||
    env.INVITE_FROM_EMAIL ||
    "notifications@testera.io"
  );
}

export function mailFromName(env = process.env) {
  return env.AMEM_FROM_NAME || "amem";
}

export function mailtrapTesting(env = process.env) {
  return String(env.MAILTRAP_USE_TESTING || "").toLowerCase() === "true";
}

export function mailtrapClientOptions(env = process.env) {
  const token = env.MAILTRAP_TOKEN;
  if (!token) return null;
  const opts = { token };
  const inbox = env.MAILTRAP_TEST_INBOX_ID || env.MAILTRAP_PROJECT_ID;
  if (inbox && mailtrapTesting(env)) opts.testInboxId = Number(inbox);
  return opts;
}

export async function getMailtrapClient(env = process.env) {
  const opts = mailtrapClientOptions(env);
  if (!opts) return null;
  if (!client) {
    const { MailtrapClient } = await import("mailtrap");
    client = new MailtrapClient(opts);
  }
  return client;
}

export function resetMailtrapClient() {
  client = undefined;
}

export async function sendLicenseMail({
  to,
  subject,
  text,
  html,
  jsonText,
  env = process.env,
  send = defaultSend,
}) {
  const payload = {
    from: { email: mailFromAddress(env), name: mailFromName(env) },
    to: [{ email: to }],
    subject,
    text,
    html,
    category: "amem-license",
    attachments: [
      {
        filename: "amem-license.json",
        type: "application/json",
        content: Buffer.from(jsonText, "utf8").toString("base64"),
      },
    ],
  };
  return send(payload, env);
}

async function defaultSend(payload, env) {
  const sdk = await getMailtrapClient(env);
  if (!sdk) return { ok: false, reason: "not_configured" };
  try {
    const resp = mailtrapTesting(env) ? await sdk.testing.send(payload) : await sdk.send(payload);
    return { ok: true, mode: mailtrapTesting(env) ? "testing" : "production", resp };
  } catch (error) {
    return {
      ok: false,
      mode: mailtrapTesting(env) ? "testing" : "production",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
