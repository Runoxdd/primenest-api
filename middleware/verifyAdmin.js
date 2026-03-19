import jwt from "jsonwebtoken";

export const verifyAdmin = (req, res, next) => {
  let token = req.cookies.token;

  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    }
  }

  if (!token) return res.status(401).json({ message: "Not Authenticated!" });

  jwt.verify(token, process.env.JWT_SECRET_KEY, async (err, payload) => {
    if (err) return res.status(403).json({ message: "Token is not Valid!" });
    
    if (!payload.isAdmin) {
      return res.status(403).json({ message: "Not Authorized! Admin only." });
    }

    req.userId = payload.id;
    next();
  });
};
