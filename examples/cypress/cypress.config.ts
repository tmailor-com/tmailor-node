// Cypress: the SDK runs in the Node process (setupNodeEvents) and the browser asks for what it needs with cy.task.
// The API key and address tokens stay in Node; the spec only sees the email address and the message fields.
import { defineConfig } from "cypress";
import { Client, WaitTimeoutError } from "tmailor";

const client = new Client(); // TMAILOR_API_KEY from the CI environment
const boxes = new Map<string, { token: string; createdAt: number }>(); // kept in Node only

export default defineConfig({
  e2e: {
    setupNodeEvents(on) {
      on("task", {
        async "tmailor:create"() {
          const box = await client.mailboxes.create();
          boxes.set(box.email, { token: box.token!, createdAt: box.createdAt });
          return { email: box.email };
        },
        async "tmailor:wait"({ email, timeout = 60_000, subjectContains = null }: { email: string; timeout?: number; subjectContains?: string | null }) {
          const saved = boxes.get(email)!;
          try {
            // since: also accept a message that arrived before the wait started (exclusive, hence - 1)
            const msg = await client.mailbox(saved.token).waitForMessage({ timeout, subjectContains, since: saved.createdAt - 1 });
            return { subject: msg.subject, otp: msg.otp, codes: msg.codes, links: msg.links, text: msg.text };
          } catch (err) {
            if (err instanceof WaitTimeoutError) return null; // cy.task must not resolve undefined
            throw err;
          }
        },
        async "tmailor:delete"(email: string) {
          const saved = boxes.get(email);
          if (saved) await client.mailbox(saved.token).delete();
          boxes.delete(email);
          return null;
        },
      });
    },
  },
});

// Spec (cypress/e2e/signup.cy.ts). Set taskTimeout above the wait timeout (cy.task defaults to 60 s):
//
// it("sign-up sends a code", () => {
//   cy.task("tmailor:create").then(({ email }: any) => {
//     cy.visit("/signup");
//     cy.get("input[name=email]").type(email);
//     cy.contains("button", "Create account").click();
//     cy.task("tmailor:wait", { email, timeout: 90_000 }, { timeout: 100_000 }).then((msg: any) => {
//       expect(msg, "verification email").to.not.equal(null);
//       cy.get("input[name=code]").type(msg.otp);
//     });
//     cy.task("tmailor:delete", email);
//   });
// });
