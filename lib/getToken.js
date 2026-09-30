// Reads the JWT from the request.
// Checks the httpOnly cookie first, then falls back to an
// "Authorization: Bearer <token>" header (used for cross-domain requests).
export const getToken = (req) => {
  const cookieToken = req.cookies?.token;
  if (cookieToken) return cookieToken;

  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }

  return null;
};
