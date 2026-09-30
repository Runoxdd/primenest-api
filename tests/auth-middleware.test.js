import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import request from "supertest";

import { getToken } from "../lib/getToken.js";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyAdmin } from "../middleware/verifyAdmin.js";

process.env.JWT_SECRET_KEY = "test-secret";

const sign = (payload) => jwt.sign(payload, process.env.JWT_SECRET_KEY);

// Tiny app that exposes one route behind each middleware
const app = express();
app.use(cookieParser());
app.get("/protected", verifyToken, (req, res) =>
  res.json({ userId: req.userId, isAdmin: req.isAdmin })
);
app.get("/admin", verifyAdmin, (req, res) => res.json({ userId: req.userId }));

// ---------- getToken ----------

test("getToken prefers the cookie over the header", () => {
  const req = {
    cookies: { token: "from-cookie" },
    headers: { authorization: "Bearer from-header" },
  };
  assert.equal(getToken(req), "from-cookie");
});

test("getToken falls back to the Bearer header", () => {
  const req = { cookies: {}, headers: { authorization: "Bearer abc123" } };
  assert.equal(getToken(req), "abc123");
});

test("getToken ignores non-Bearer headers and returns null", () => {
  assert.equal(getToken({ cookies: {}, headers: { authorization: "Basic xyz" } }), null);
  assert.equal(getToken({ headers: {} }), null);
});

// ---------- verifyToken ----------

test("verifyToken: 401 with no token", async () => {
  const res = await request(app).get("/protected");
  assert.equal(res.status, 401);
});

test("verifyToken: 403 with a bad token", async () => {
  const res = await request(app)
    .get("/protected")
    .set("Authorization", "Bearer not-a-real-token");
  assert.equal(res.status, 403);
});

test("verifyToken: accepts a valid Bearer token", async () => {
  const res = await request(app)
    .get("/protected")
    .set("Authorization", `Bearer ${sign({ id: "u1", isAdmin: false })}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { userId: "u1", isAdmin: false });
});

test("verifyToken: accepts a valid cookie token", async () => {
  const res = await request(app)
    .get("/protected")
    .set("Cookie", `token=${sign({ id: "u2" })}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.userId, "u2");
});

// ---------- verifyAdmin ----------

test("verifyAdmin: 401 with no token", async () => {
  const res = await request(app).get("/admin");
  assert.equal(res.status, 401);
});

test("verifyAdmin: 403 for a non-admin user", async () => {
  const res = await request(app)
    .get("/admin")
    .set("Authorization", `Bearer ${sign({ id: "u1", isAdmin: false })}`);
  assert.equal(res.status, 403);
  assert.match(res.body.message, /Admin only/);
});

test("verifyAdmin: lets an admin through", async () => {
  const res = await request(app)
    .get("/admin")
    .set("Authorization", `Bearer ${sign({ id: "a1", isAdmin: true })}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.userId, "a1");
});
