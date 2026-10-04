// 仅追加的事件存储（内存实现，接口可替换为持久化实现）。
// 不变量：
//  1) event_id 全局幂等——重复提交同一事件不会产生第二条；
//  2) 每个聚合的 version 严格递增，expectedVersion 冲突即拒绝（乐观并发）；
//  3) 订阅者按 append 顺序同步投递，异常被隔离，不影响存储。

import { DomainError, ErrorCodes } from "./errors.js";

export class EventStore {
  #events = [];
  #byEventId = new Map();
  #aggregateHeads = new Map(); // aggregateKey -> version
  #subscribers = new Set();

  subscribe(handler) {
    this.#subscribers.add(handler);
    return () => this.#subscribers.delete(handler);
  }

  /** 追加事件。expectedVersion 为该聚合当前最新版本（新聚合传 0 或省略）。 */
  append(event, expectedVersion) {
    const errors = validateEventShape(event);
    if (errors.length) throw new DomainError(ErrorCodes.VALIDATION, "事件校验失败", { errors });

    if (this.#byEventId.has(event.event_id)) {
      // 幂等：同一 event_id 视为重复提交，原样返回已存事件。
      return this.#byEventId.get(event.event_id);
    }

    const key = aggregateKey(event);
    const current = this.#aggregateHeads.get(key) ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== current) {
      throw new DomainError(ErrorCodes.CONCURRENCY, "聚合版本冲突，请基于最新状态重试", {
        aggregate: key,
        expected: expectedVersion,
        current,
      });
    }
    if (event.version !== current + 1) {
      throw new DomainError(ErrorCodes.CONCURRENCY, "事件 version 必须为聚合的下一个版本", {
        aggregate: key,
        expected: current + 1,
        got: event.version,
      });
    }

    const stored = Object.freeze({ ...event });
    this.#events.push(stored);
    this.#byEventId.set(stored.event_id, stored);
    this.#aggregateHeads.set(key, stored.version);

    for (const handler of this.#subscribers) {
      try {
        handler(stored);
      } catch {
        // 订阅失败不得破坏写入；投影应可重放修复。
      }
    }
    return stored;
  }

  getEvent(eventId) {
    return this.#byEventId.get(eventId);
  }

  eventsForAggregate(aggregateType, aggregateId) {
    const key = `${aggregateType}/${aggregateId}`;
    return this.#events.filter((e) => aggregateKey(e) === key);
  }

  /** 重放全部事件构建投影（按写入顺序）。 */
  replay(projection, { from = 0 } = {}) {
    for (const event of this.#events.slice(from)) projection.apply(event);
    return projection;
  }

  all() {
    return [...this.#events];
  }
}

const aggregateKey = (e) => `${e.aggregate_type}/${e.aggregate_id}`;

// 最小形状校验，避免服务层把非法事件写进存储；完整语义校验见 validator.js。
function validateEventShape(event) {
  const errors = [];
  if (!event || typeof event !== "object") return ["事件必须是对象"];
  for (const name of ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"]) {
    if (!(name in event)) errors.push(`缺少字段：${name}`);
  }
  if (!Number.isInteger(event.version) || event.version < 1) errors.push("version 必须是正整数");
  if (Number.isNaN(Date.parse(event.occurred_at))) errors.push("occurred_at 非法");
  return errors;
}
