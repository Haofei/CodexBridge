import { readJsonFile } from "../utils/file.js";

export async function readAccountMetadata(authFile) {
  const auth = await readJsonFile(authFile);
  if (!auth) {
    return {
      status: "missing",
      source: authFile,
    };
  }

  const tokens = auth?.tokens ?? {};
  const idToken =
    tokens?.id_token ??
    tokens?.idToken ??
    auth?.id_token ??
    auth?.idToken ??
    null;
  const accessToken =
    tokens?.access_token ??
    tokens?.accessToken ??
    auth?.access_token ??
    null;

  const idPayload = idToken ? decodeJwtPayload(idToken) : null;
  const accessPayload = accessToken ? decodeJwtPayload(accessToken) : null;

  const issuedAt = unixToIso(accessPayload?.iat ?? idPayload?.iat);
  const expiresAt = unixToIso(accessPayload?.exp ?? idPayload?.exp);
  const status = deriveStatus(accessPayload?.exp ?? idPayload?.exp);

  const tokenMeta = [];
  if (accessToken) {
    tokenMeta.push({
      type: "Access Token",
      email:
        accessPayload?.["https://api.openai.com/profile"]?.email ??
        accessPayload?.email ??
        null,
      issuer: accessPayload?.iss ?? null,
      issuedAt: unixToIso(accessPayload?.iat),
      expiresAt: unixToIso(accessPayload?.exp),
      status: deriveStatus(accessPayload?.exp),
      preview: formatTokenPreview(accessToken),
      scopes: accessPayload?.scope ?? tokens?.scope ?? tokens?.scopes ?? null,
      audience: Array.isArray(accessPayload?.aud)
        ? accessPayload.aud.join(", ")
        : accessPayload?.aud ?? null,
    });
  }

  return {
    status,
    email:
      idPayload?.email ??
      accessPayload?.["https://api.openai.com/profile"]?.email ??
      auth?.email ??
      null,
    issuer: idPayload?.iss ?? accessPayload?.iss ?? null,
    accountId: tokens?.account_id ?? auth?.account_id ?? null,
    subject: idPayload?.sub ?? accessPayload?.sub ?? null,
    issuedAt,
    expiresAt,
    device: auth?.device?.name ?? auth?.device_id ?? null,
    source: authFile,
    tokens: tokenMeta,
  };
}

export function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded =
      normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function unixToIso(value) {
  if (value === undefined || value === null) return null;
  return new Date(value * 1000).toISOString();
}

export function deriveStatus(exp) {
  if (exp === undefined || exp === null) return "unknown";
  return Date.now() > exp * 1000 ? "expired" : "active";
}

export function formatTokenPreview(token) {
  if (!token || token.length < 12) return token ?? null;
  return `${token.slice(0, 12)}…${token.slice(-6)}`;
}
