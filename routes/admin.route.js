import express from "express";
import { getUsers, delistHouse, banUser } from "../controllers/admin.controller.js";
import { verifyAdmin } from "../middleware/verifyAdmin.js";

const router = express.Router();

router.get("/users", verifyAdmin, getUsers);
router.put("/delist/:id", verifyAdmin, delistHouse);
router.put("/ban/:id", verifyAdmin, banUser);

export default router;
