import jwt from "jsonwebtoken";
import { getToken } from "../lib/getToken.js";

export const verifyToken = (req, res, next) => {
  const token = getToken(req);

  if (!token) return res.status(401).json({ message: "Not Authenticated!" });

  jwt.verify(token, process.env.JWT_SECRET_KEY, (err, payload) => {
    if (err) return res.status(403).json({ message: "Token is not Valid!" });

    req.userId = payload.id;
    req.isAdmin = Boolean(payload.isAdmin);
    next();
  });
};
