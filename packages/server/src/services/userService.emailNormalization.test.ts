import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { getDb } from "../db/index";
import { passwordResets, users } from "../db/schema";
import { requestPasswordReset } from "./userService";


afterEach(async () => {
  await closeTestDatabase();
});

test("forgot-password lookup normalizes input before lookup", async ({ db: database }) => {

  const db = getDb();

  const [user] = await db.insert(users).values({
    id: "11111111-1111-1111-1111-111111111111",
    email: "owner@example.com",
    name: "owner",
    displayName: "owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();

  await requestPasswordReset("Owner@Example.COM");

  const rows = await db.select().from(passwordResets);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, user.id);
});
