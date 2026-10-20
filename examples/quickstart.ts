// Create an address, trigger an email to it, wait for the message, print the code and links, delete the address.
//   TMAILOR_API_KEY=tmk_live_... npx tsx examples/quickstart.ts
import { Client, WaitTimeoutError } from "tmailor";

async function signUpSomewhere(email: string): Promise<void> {
  console.log(`Send a test email to ${email} now (for example from the sign-up form you are testing).`);
}

const client = new Client(); // reads TMAILOR_API_KEY
const box = await client.mailboxes.create(); // random address on a shared domain
console.log(box.email);
try {
  await signUpSomewhere(box.email);
  // `since` is exclusive (receivedAt > since); "- 1" also accepts a message received in the creation second.
  const msg = await box.waitForMessage({ timeout: 120_000, since: box.createdAt - 1 });
  console.log(msg.subject, msg.otp, msg.codes, msg.links);
} catch (err) {
  if (err instanceof WaitTimeoutError) console.log("no message within 2 minutes");
  else throw err;
} finally {
  await box.delete();
}
