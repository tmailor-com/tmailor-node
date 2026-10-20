// Playwright fixture: every test gets its own fresh address, deleted afterwards.
// Requires @playwright/test. The API key stays in the Node test process; it never reaches the browser.
import { test as base, expect } from "@playwright/test";
import { Client, type LoadedMailbox } from "tmailor";

const client = new Client(); // TMAILOR_API_KEY from the CI secret store

export const test = base.extend<{ inbox: LoadedMailbox }>({
  inbox: async ({}, use) => {
    const box = await client.mailboxes.create();
    try {
      await use(box);
    } finally {
      await box.delete();
    }
  },
});

export { expect };

// Example spec (tests/signup.spec.ts):
//
// import { test, expect } from "./fixtures";
//
// test("sign-up sends a verification code", async ({ page, inbox }) => {
//   await page.goto("https://app.example.com/signup");
//   await page.getByLabel("Email").fill(inbox.email);
//   await page.getByRole("button", { name: "Create account" }).click();
//   const msg = await inbox.waitForMessage({ timeout: 60_000, since: inbox.createdAt - 1, subjectContains: "verify" });
//   expect(msg.otp).toMatch(/^\d{6}$/);
//   await page.getByLabel("Code").fill(msg.otp!);
// });
