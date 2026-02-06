import express from "express";
import { chatWithAssistant } from "../controllers/assistant.controller.js";
import { verifyToken } from "../middleware/verifyToken.js";

const router = express.Router();

// We use verifyToken because your objective mentions secure user data
router.post("/chat", verifyToken, chatWithAssistant);

export default router;