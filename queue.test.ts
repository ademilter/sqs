import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Redis } from "ioredis";
import { Queue } from "./queue";
import { delay, formatMessageQueueKey } from "./utils";

const randomValue = () => crypto.randomUUID();
const redis = new Redis();
const consumerClient = new Redis();

describe("Queue with a single client", () => {
  test("should add item to queue", async () => {
    const queue = new Queue({ redis, queueName: "app-logs" });

    const sendMessageResult = (await queue.sendMessage({
      dev: "hezarfennnn",
      age: 27,
    })) as string;

    const res = await redis.xrevrange(
      formatMessageQueueKey("app-logs"),
      "+",
      "-",
      "COUNT",
      1
    );
    await redis.xdel(formatMessageQueueKey("app-logs"), res[0][0]);
    expect(res[0][0]).toEqual(sendMessageResult);
  });

  test(
    "should enqueue with a delay",
    async () => {
      const fakeValue = randomValue();
      const queue = new Queue({ redis, queueName: "app-logs" });
      await queue.sendMessage(
        {
          dev: fakeValue,
        },
        2
      );

      await delay(5000);
      const res = await redis.xrevrange(
        formatMessageQueueKey("app-logs"),
        "+",
        "-",
        "COUNT",
        1
      );
      expect(res[0][1]).toEqual(["messageBody", `{"dev":"${fakeValue}"}`]);
    },
    { timeout: 10000 }
  );

  test("should try to read from stream with consumer group", async () => {
    const queue = new Queue({ redis, queueName: "app-logs" });
    const receiveMessageRes = await queue.receiveMessage("consumer-1");

    expect(receiveMessageRes?.streamId ?? "").toBeTruthy();
  });

  test(
    "should poll until data arives",
    async () => {
      const fakeValue = randomValue();

      const producer = new Queue({ redis, queueName: "app-logs" });
      const consumer = new Queue({
        redis: consumerClient,
        queueName: "app-logs",
      });
      await producer.sendMessage(
        {
          dev: fakeValue,
        },
        2
      );

      const receiveMessageRes = await consumer.receiveMessage(
        "consumer-1",
        5000
      );

      expect(receiveMessageRes?.body.messageBody.dev).toEqual(fakeValue);
    },
    { timeout: 10000 }
  );
});

describe("Queue with Multiple Consumers", () => {
  const messageCount = 10;
  const consumerCount = 5;
  let producer: Queue;
  let consumers: Queue[] = [];
  let messagesSent = new Set();
  let messagesReceived = new Map();

  beforeAll(() => {
    // Initialize Redis and Queue for the producer
    const producerRedis = new Redis();
    producer = new Queue({ redis: producerRedis, queueName: "app-logs" });

    // Initialize Redis and Queues for consumers
    for (let i = 0; i < consumerCount; i++) {
      const consumerRedis = new Redis();
      const consumer = new Queue({
        redis: consumerRedis,
        queueName: "app-logs",
      });
      consumers.push(consumer);
    }
  });

  test(
    "should process each message exactly once across all consumers",
    async () => {
      // Send messages
      for (let i = 0; i < messageCount; i++) {
        const message = `Message ${randomValue()}`;
        await producer.sendMessage({ message });
        messagesSent.add(message);
      }

      // Start consuming messages
      const consumePromises = consumers.map((consumer, index) => {
        return new Promise<void>(async (resolve) => {
          for (let i = 0; i < messageCount / consumerCount; i++) {
            const res = await consumer.receiveMessage(`consumer-${index}`);
            if (res && res.body.messageBody) {
              const message = res.body.messageBody.message;
              if (!messagesReceived.has(message)) {
                messagesReceived.set(message, index);
              }
            }
          }
          resolve();
        });
      });

      await Promise.all(consumePromises);

      // Assertions
      expect(messagesReceived.size).toBe(messageCount);
      messagesSent.forEach((message) => {
        expect(messagesReceived.has(message)).toBe(true);
      });

      // Ensure no message was processed by more than one consumer
      expect(new Set(messagesReceived.values()).size).toBeLessThanOrEqual(
        consumerCount
      );
    },
    { timeout: 15 * 1000 }
  );

  afterAll(async () => {
    // Close Redis connections and cleanup
    await producer.config.redis.quit();
    for (const consumer of consumers) {
      await consumer.config.redis.quit();
    }
  });
});
