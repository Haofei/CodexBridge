import { isPlainObject } from "../utils/object.js";

export function resolveOutputSchemaFromBody(body) {
  if (!body || typeof body !== "object") return null;
  if (body.output_schema !== undefined) {
    return ensureJsonSchemaObject(body.output_schema, "output_schema");
  }
  if (body.outputSchema !== undefined) {
    return ensureJsonSchemaObject(body.outputSchema, "outputSchema");
  }

  const responseFormat = body.response_format ?? body.responseFormat;
  if (responseFormat === undefined || responseFormat === null) return null;
  if (typeof responseFormat === "string") {
    const normalized = responseFormat.toLowerCase();
    if (normalized === "json_schema") {
      throw new Error(
        'response_format "json_schema" requires an accompanying schema.',
      );
    }
    if (normalized === "json_object") {
      return { type: "object" };
    }
    return null;
  }
  if (!isPlainObject(responseFormat)) {
    throw new Error("response_format must be an object when provided.");
  }

  const type =
    typeof responseFormat.type === "string"
      ? responseFormat.type.toLowerCase()
      : null;
  if (type === "json_schema" || responseFormat.json_schema || responseFormat.schema) {
    const schemaCandidate =
      responseFormat?.json_schema?.schema ??
      responseFormat?.schema ??
      responseFormat?.json_schema;
    if (!schemaCandidate) {
      throw new Error(
        "response_format.json_schema.schema must be provided for type=json_schema.",
      );
    }
    return ensureJsonSchemaObject(
      schemaCandidate,
      "response_format.json_schema.schema",
    );
  }
  if (type === "json_object") {
    return { type: "object" };
  }
  if (type && type !== "text") {
    throw new Error(`Unsupported response_format type "${responseFormat.type}".`);
  }
  if (responseFormat.schema) {
    return ensureJsonSchemaObject(responseFormat.schema, "response_format.schema");
  }
  return null;
}

export function ensureJsonSchemaObject(candidate, label = "output schema") {
  if (!isPlainObject(candidate)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return candidate;
}
