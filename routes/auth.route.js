import express from "express";
import { login, logout, register } from "../controllers/auth.controller.js";
import { validateLogin, validateRegister } from "../middleware/validateAuth.js";

const router = express.Router();

router.post("/register", validateRegister, register);
router.post("/login", validateLogin, login);
router.post("/logout", logout);

export default router;
