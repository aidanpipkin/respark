// How long a real person would take to answer a text: read it, think, type the reply on a phone.
// Instant answers read as a bot; long waits lose the moment. Every delay is randomised so no two
// replies land on the same rhythm.

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Seconds to wait before an automatic reply goes out. */
export function replyDelaySeconds(inbound: string, reply: string, opts: { quick?: boolean } = {}) {
  const inLen = String(inbound || '').length, outLen = String(reply || '').length;
  if (opts.quick) return Math.round(rand(12, 30)); // "1" or "2" to pick a time: answer fast, like someone holding the phone
  const read = Math.min(18, inLen * 0.05) + 2;      // a few seconds to read, longer for long texts
  const think = rand(6, 22);                         // pause before replying
  const type = outLen / rand(3, 4.5);                // thumb typing, 3 to 4.5 characters a second
  const total = (read + think + type) * rand(0.85, 1.2);
  return Math.round(Math.max(25, Math.min(150, total)));
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
