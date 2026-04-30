import crypto from "crypto";

/**
 * Validates an inbound Twilio webhook request using the X-Twilio-Signature
 * header. Without this check, anyone could POST a forged Body/From and
 * confirm or reject another user's pending intents.
 *
 * Algorithm: HMAC-SHA1 over (full URL + sorted concatenated form params),
 * base64-encoded, compared against the header in constant time.
 *
 * Returns true when:
 *   - TWILIO_AUTH_TOKEN is set AND the signature matches.
 *
 * Returns false when:
 *   - TWILIO_AUTH_TOKEN is set AND the signature is missing or wrong.
 *
 * When TWILIO_AUTH_TOKEN is NOT set (mock/dev mode), validation is skipped
 * and the function returns true. Production deployments MUST set the env
 * var so the webhooks are actually authenticated.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signatureHeader: string | null
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return true;
  }
  if (!signatureHeader) {
    return false;
  }

  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const expected = crypto
    .createHmac("sha1", authToken)
    .update(data, "utf-8")
    .digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Reads the FormData from a Twilio request, validates the signature, and
 * returns either the validated params or null if validation fails.
 *
 * The full URL must be passed in by the caller because Next.js's
 * `request.url` may already be canonicalized in ways that differ from
 * what Twilio signed (e.g., trailing slashes). We rebuild it from the
 * forwarded host headers so the signature matches.
 */
export async function readVerifiedTwilioBody(
  req: Request
): Promise<{ params: Record<string, string> } | null> {
  const formData = await req.formData();
  const params: Record<string, string> = {};
  formData.forEach((value, key) => {
    if (typeof value === "string") {
      params[key] = value;
    }
  });

  const signature = req.headers.get("x-twilio-signature");

  // Reconstruct the public URL Twilio used. Vercel sets x-forwarded-host
  // and x-forwarded-proto so the inner Request.url (which uses the
  // internal hostname) doesn't break signature verification.
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const inner = new URL(req.url);
  const publicUrl = host
    ? `${proto}://${host}${inner.pathname}${inner.search}`
    : req.url;

  if (!verifyTwilioSignature(publicUrl, params, signature)) {
    return null;
  }
  return { params };
}
