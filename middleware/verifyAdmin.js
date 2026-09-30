import { verifyToken } from "./verifyToken.js";

// Same checks as verifyToken, plus the user must be an admin.
export const verifyAdmin = (req, res, next) => {
  verifyToken(req, res, () => {
    if (!req.isAdmin) {
      return res.status(403).json({ message: "Not Authorized! Admin only." });
    }
    next();
  });
};
