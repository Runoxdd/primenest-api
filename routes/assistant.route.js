import express from "express";
import { chatWithAssistant, clearSession, getSessionInfo } from "../controllers/assistant.controller.js";
import { verifyToken } from "../middleware/verifyToken.js";

const router = express.Router();

// Chat endpoint with conversation memory
router.post("/chat", verifyToken, chatWithAssistant);

// Session management endpoints
router.post("/clear", verifyToken, clearSession);
router.get("/session/:sessionId", verifyToken, getSessionInfo);

export default router;