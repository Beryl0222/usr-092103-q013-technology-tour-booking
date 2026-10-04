// 供应商通知网关：所有外部回调（确认/拒绝、库存、设备公告、支付结果、离线签到补传…）
// 必须先经此入口，再允许驱动领域动作。
//
// 顺序语义（同一 stream 内，例如某产品的设备状态流或某个预订行）：
//   排序键 = (source_version, occurred_at)
//   - 键更大            -> APPLIED，仅这种通知会执行业务回调；
//   - 键完全相同/已见过 -> DUPLICATE，只留痕不执行（重复回调、离线重传在此挡下）；
//   - 键更小（迟到旧版） -> STALE，隔离留痕，绝不允许旧状态覆盖新状态。
// 键更大但出现版本跳号时，缺口记录在 gap_from 字段以便排查，不阻塞当前通知。

import { ErrorCodes, DomainError } from "./errors.js";
import { now, newId } from "./runtime.js";

export class NotificationGateway {
  #store;
  // stream -> { version, occurredAt } 已应用的最高水位
  #highWater = new Map();
  #seen = new Set(); // supplier_id + notification_id

  constructor(store) {
    this.#store = store;
  }

  /**
   * @param {object} notice
   * @param {string} notice.stream 顺序流标识（同一主题的状态更新必须共用）
   * @param {number} notice.source_version 来源版本号（正整数，单调递增）
   * @param {string} notice.occurred_at 来源事件发生时间
   * @param {string} notice.notification_id 来源通知唯一号（重复回调判定）
   * @param {(data) => void} [apply] 仅当 disposition=APPLIED 时调用一次
   * @returns {{disposition: string, event: object}}
   */
  ingest(notice, apply) {
    const { supplier_id, notification_id, source_version, occurred_at, stream, kind, data = {} } = notice;
    if (!supplier_id || !notification_id || !stream) {
      throw new DomainError(ErrorCodes.VALIDATION, "通知缺少 supplier_id/notification_id/stream");
    }
    if (!Number.isInteger(source_version) || source_version < 1) {
      throw new DomainError(ErrorCodes.VALIDATION, "source_version 必须是正整数", { notification_id });
    }
    if (Number.isNaN(Date.parse(occurred_at))) {
      throw new DomainError(ErrorCodes.VALIDATION, "occurred_at 非法", { notification_id });
    }

    const dedupeKey = `${supplier_id}|${notification_id}`;
    const watermark = this.#highWater.get(stream);
    let disposition;
    if (this.#seen.has(dedupeKey)) {
      disposition = "DUPLICATE";
    } else if (watermark && compareKey(source_version, occurred_at, watermark.version, watermark.occurredAt) < 0) {
      disposition = "STALE";
    } else if (watermark && compareKey(source_version, occurred_at, watermark.version, watermark.occurredAt) === 0) {
      disposition = "DUPLICATE";
    } else {
      disposition = "APPLIED";
    }

    const gapFrom =
      disposition === "APPLIED" && watermark && source_version > watermark.version + 1
        ? watermark.version + 1
        : null;

    const event = {
      event_id: newId("evt"),
      event_type: "NOTIFICATION_RECORDED",
      aggregate_type: "supplier_notification",
      aggregate_id: notification_id,
      occurred_at: now(),
      version: this.#nextNotificationVersion(notification_id),
      summary: `${supplier_id} 通知 ${notification_id} 判定为 ${disposition}`,
      source: {
        system: "supplier-gateway",
        supplier_id,
        notification_id,
        source_version,
        received_at: now(),
      },
      payload: {
        supplier_id,
        notification_id,
        source_version,
        stream,
        kind,
        occurred_at,
        disposition,
        gap_from: gapFrom,
      },
    };
    this.#store.append(event);
    this.#seen.add(dedupeKey);

    if (disposition === "APPLIED") {
      this.#highWater.set(stream, { version: source_version, occurredAt: occurred_at });
      if (apply) apply(data);
    }
    return { disposition, event };
  }

  #nextNotificationVersion(notificationId) {
    // 同一通知重投共享聚合；首次为 1，重复留痕递增。
    const events = this.#store.eventsForAggregate("supplier_notification", notificationId);
    return events.length + 1;
  }

  watermark(stream) {
    return this.#highWater.get(stream) ? { ...this.#highWater.get(stream) } : null;
  }
}

function compareKey(versionA, atA, versionB, atB) {
  if (versionA !== versionB) return versionA < versionB ? -1 : 1;
  const ta = Date.parse(atA);
  const tb = Date.parse(atB);
  return ta === tb ? 0 : ta < tb ? -1 : 1;
}
