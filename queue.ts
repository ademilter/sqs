import { EventEmitter } from "events";
import Redis from "ioredis";
import {
  formatMessageQueueKey,
  invariant,
  parseRedisStreamMessage,
  retryWithBackoff,
} from "./utils";

export const DEFAULT_CONSUMER_GROUP_NAME = "Messages";
export const DEFAULT_CONSUMER_PREFIX = "Consumer";
export const DEFAULT_QUEUE_NAME = "Queue";
export const DEFAULT_CONCURRENCY_LIMIT = 0;
export const DEFAULT_AUTO_VERIFY = true;

export type QueueConfig = {
  redis: Redis;
  queueName?: string;
  concurrencyLimit?: 0 | 1 | 2 | 3 | 4 | 5;
  autoVerify?: boolean;
  consumerGroupName?: string;
  consumerNamePrefix?: string;
};

export class Queue extends EventEmitter {
  config: QueueConfig;
  private messageTimeouts = new Set<NodeJS.Timer>();

  constructor(config: QueueConfig) {
    super();
    this.config = {
      redis: config.redis,

      concurrencyLimit: config.concurrencyLimit ?? DEFAULT_CONCURRENCY_LIMIT,
      autoVerify: config.autoVerify ?? DEFAULT_AUTO_VERIFY,
      consumerGroupName:
        config.consumerGroupName ?? DEFAULT_CONSUMER_GROUP_NAME,
      consumerNamePrefix: config.consumerNamePrefix ?? DEFAULT_CONSUMER_PREFIX,
      queueName: config.queueName
        ? this.appendPrefixTo(config.queueName)
        : this.appendPrefixTo(DEFAULT_QUEUE_NAME),
    };
    this.initializeConsumerGroup();
    this.setupShutdownHandler();
  }

  private appendPrefixTo(key: string) {
    return formatMessageQueueKey(key);
  }

  private async initializeConsumerGroup() {
    invariant(
      this.config.consumerGroupName,
      "Consumer group name cannot be empty when initializing consumer group"
    );
    invariant(
      this.config.queueName,
      "Queue name cannot be empty when initializing consumer group"
    );

    try {
      await this.config.redis.xgroup(
        "CREATE",
        this.config.queueName,
        this.config.consumerGroupName,
        "$",
        "MKSTREAM"
      );
    } catch (error) {
      if (
        (error as Error).message !==
        "BUSYGROUP Consumer Group name already exists"
      ) {
        this.emit("error", error);
      }
    }
  }

  async sendMessage<T extends {}>(payload: T, delayInSeconds: number = 0) {
    const { redis } = this.config;
    try {
      const flattenedPayload = Object.entries({
        messageBody: JSON.stringify(payload),
      }).flat() as string[];

      const streamKey = this.config.queueName;
      invariant(streamKey, "Queue name cannot be empty when sending a message");

      const _sendMessage = () =>
        redis.xadd(streamKey, "*", ...flattenedPayload);

      if (delayInSeconds > 0) {
        let streamIdResult: string | null = null;

        const timeoutId = setTimeout(() => {
          retryWithBackoff(_sendMessage)
            .then((res) => {
              streamIdResult = res;
              this.messageTimeouts.delete(timeoutId);
            })
            .catch((error) => {
              this.emit("error", error);
            });
        }, delayInSeconds * 1000);
        this.messageTimeouts.add(timeoutId);
        return streamIdResult;
      } else {
        return await retryWithBackoff(_sendMessage);
      }
    } catch (error) {
      this.emit("error", error);
      console.error("Error in sendMessage:", error);
      return null;
    }
  }

  async receiveMessage<StreamResult>(consumerName: string, blockTimeMs = 0) {
    const { redis } = this.config;

    const receiveAndProcessMessage = async () => {
      invariant(
        this.config.consumerGroupName,
        "Consumer group name cannot be empty when receiving a message"
      );

      invariant(
        this.config.queueName,
        "Queue name cannot be empty when receving a message"
      );

      try {
        const xreadRes = await redis.xreadgroup(
          "GROUP",
          this.config.consumerGroupName,
          consumerName,
          "COUNT",
          1,
          "BLOCK",
          blockTimeMs,
          "STREAMS",
          this.config.queueName,
          ">"
        );
        const parsedMessage = parseRedisStreamMessage<StreamResult>(xreadRes);
        if (!parsedMessage) return null;

        await this.verifyMessage<StreamResult>(redis, parsedMessage);
        return parsedMessage;
      } catch (error) {
        this.emit(
          "receiveError",
          `Error receiving message: ${(error as Error).message}`
        );
        throw error;
      }
    };

    try {
      return await retryWithBackoff(receiveAndProcessMessage);
    } catch (finalError) {
      console.error(
        `Final attempt to receive message failed: ${
          (finalError as Error).message
        }`
      );
      throw finalError;
    }
  }

  private async verifyMessage<StreamResult>(
    redis: Redis,
    resultObject: { streamId: string; body: StreamResult }
  ) {
    const attemptAck = async () => {
      invariant(
        this.config.consumerGroupName,
        "Consumer group name cannot be empty when verifying a message"
      );

      invariant(
        this.config.queueName,
        "Queue name cannot be empty when verifying a message"
      );

      await redis.xack(
        this.config.queueName,
        this.config.consumerGroupName,
        resultObject.streamId
      );
    };

    try {
      await retryWithBackoff(attemptAck);
    } catch (finalError) {
      console.error(
        `Final attempt to acknowledge message failed: ${
          (finalError as Error).message
        }`
      );
      this.emit("error", finalError);
      //Return null to prevent another retry within receiveMessage
      return null;
    }
  }

  private setupShutdownHandler() {
    process.on("SIGINT", this.shutdown.bind(this));
    process.on("SIGTERM", this.shutdown.bind(this));
  }

  private async shutdown() {
    console.log("Shutting down gracefully...");
    this.messageTimeouts.forEach((timeoutId) => clearTimeout(timeoutId));
    // Add any other cleanup logic here
    process.exit(0);
  }
}
