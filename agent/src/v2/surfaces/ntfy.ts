// Bull v2 — ntfy push leg (fleet pattern, mirrors castle conductor/notify.mjs). A halt or
// escalation must reach CJ's phone even when Discord is rate-limited or unread — ntfy is the
// fleet's paging rail. Env-gated: NTFY_URL + NTFY_TOPIC + NTFY_TOKEN all set → one POST;
// anything missing → silent no-op (tests and un-provisioned boxes never fail on this). Never throws.
export async function sendNtfy(title: string, text: string, urgent = true): Promise<boolean> {
  const url = process.env.NTFY_URL;
  const topic = process.env.NTFY_TOPIC;
  const token = process.env.NTFY_TOKEN;
  const body = String(text ?? "").slice(0, 3800); // ntfy message cap headroom
  if (!url || !topic || !token || !body) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch(`${url}/${topic}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        title: String(title || "Bull").slice(0, 120),
        priority: urgent ? "urgent" : "default",
        tags: urgent ? "rotating_light" : "white_check_mark",
      },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return !!(r && r.ok);
  } catch {
    return false; // network/abort/anything → never break the caller
  }
}
