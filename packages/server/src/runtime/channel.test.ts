import { describe, expect, it } from "vitest";
import { Channel } from "./channel.js";

async function drain<T>(channel: Channel<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of channel) out.push(value);
  return out;
}

describe("Channel", () => {
  it("delivers pushed values in order, then ends on close", async () => {
    const channel = new Channel<number>();
    channel.push(1);
    channel.push(2);
    const consumer = drain(channel);
    channel.push(3);
    channel.close();
    expect(await consumer).toEqual([1, 2, 3]);
  });

  it("interleaves producer and consumer (waiter path)", async () => {
    const channel = new Channel<string>();
    const consumer = drain(channel);
    await new Promise((r) => setTimeout(r, 5));
    channel.push("a");
    await new Promise((r) => setTimeout(r, 5));
    channel.push("b");
    channel.close();
    expect(await consumer).toEqual(["a", "b"]);
  });

  it("ignores pushes after close", async () => {
    const channel = new Channel<number>();
    channel.push(1);
    channel.close();
    channel.push(2);
    expect(await drain(channel)).toEqual([1]);
  });

  it("drains buffered values even when closed first", async () => {
    const channel = new Channel<number>();
    channel.push(1);
    channel.push(2);
    channel.close();
    expect(await drain(channel)).toEqual([1, 2]);
  });
});
