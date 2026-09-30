import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";

import { validateLogin, validateRegister } from "../middleware/validateAuth.js";

// Stand-in for the real controllers: echoes back what reached it,
// so we can check that validation ran and cleaned the input.
const app = express();
app.use(express.json());
app.post("/register", validateRegister, (req, res) => res.json(req.body));
app.post("/login", validateLogin, (req, res) => res.json(req.body));

const validUser = { username: "runo_dev", email: "runo@example.com", password: "secret123" };

// ---------- register ----------

test("register: passes a valid body through (trimmed)", async () => {
  const res = await request(app)
    .post("/register")
    .send({ ...validUser, username: "  runo_dev ", email: " runo@example.com " });
  assert.equal(res.status, 200);
  assert.equal(res.body.username, "runo_dev");
  assert.equal(res.body.email, "runo@example.com");
});

test("register: 400 with every field missing", async () => {
  const res = await request(app).post("/register").send({});
  assert.equal(res.status, 400);
  assert.deepEqual(Object.keys(res.body.errors).sort(), ["email", "password", "username"]);
});

test("register: 400 for a bad email", async () => {
  const res = await request(app).post("/register").send({ ...validUser, email: "not-an-email" });
  assert.equal(res.status, 400);
  assert.ok(res.body.errors.email);
});

test("register: 400 for a short password", async () => {
  const res = await request(app).post("/register").send({ ...validUser, password: "123" });
  assert.equal(res.status, 400);
  assert.ok(res.body.errors.password);
});

test("register: 400 for a username with spaces or symbols", async () => {
  const res = await request(app).post("/register").send({ ...validUser, username: "runo dev!" });
  assert.equal(res.status, 400);
  assert.ok(res.body.errors.username);
});

test("register: 400 when password is not a string", async () => {
  const res = await request(app).post("/register").send({ ...validUser, password: 12345678 });
  assert.equal(res.status, 400);
  assert.ok(res.body.errors.password);
});

// ---------- login ----------

test("login: passes a valid body through", async () => {
  const res = await request(app).post("/login").send({ username: "runo_dev", password: "x" });
  assert.equal(res.status, 200);
});

test("login: 400 with missing fields", async () => {
  const res = await request(app).post("/login").send({ username: "   " });
  assert.equal(res.status, 400);
  assert.ok(res.body.errors.username);
  assert.ok(res.body.errors.password);
});
