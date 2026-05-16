export function createApiKeyMiddleware(apiKey) {
  return (req, res, next) => {
    if (req.path === "/health") return next();
    if (!apiKey) return next();

    const authHeader = req.get("authorization") ?? "";
    let suppliedKey = null;
    if (authHeader.toLowerCase().startsWith("bearer ")) {
      suppliedKey = authHeader.slice(7).trim();
    } else if (req.get("x-api-key")) {
      suppliedKey = req.get("x-api-key");
    }

    if (suppliedKey !== apiKey) {
      return res.status(401).json({
        error: {
          message: "Invalid or missing API key.",
          type: "unauthorized",
        },
      });
    }
    return next();
  };
}
