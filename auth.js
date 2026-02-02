export function validateToken(token) {
  return token === process.env.AUTH_TOKEN;
}

export function authMiddleware(req, res, next) {
  const token =
    req.headers.authorization?.replace("Bearer ", "") || req.query.token;

  if (!validateToken(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

export function socketAuthMiddleware(socket, next) {
  const token = socket.handshake.auth.token || socket.handshake.query.token;

  if (!validateToken(token)) {
    return next(new Error("Unauthorized"));
  }

  next();
}
