// 设备状态公告：无人车、无人机取餐、机器人门店、智能工厂的运营/停运状态。
// 公告经通知网关按 source_version+occurred_at 定序后写入；旧版本迟到不能复活已停运设备。

import { DomainError, ErrorCodes } from "./errors.js";
import { now, newId } from "./runtime.js";

export const EquipmentStatus = Object.freeze({
  OPERATIONAL: "OPERATIONAL",
  OUTAGE: "OUTAGE",
  REDUCED_CAPACITY: "REDUCED_CAPACITY",
});

/**
 * 登记设备公告。通常由 NotificationGateway 的 APPLIED 回调调用。
 * scope: { product_id, slot_id? }；slot_id 缺省表示该产品全部时段。
 */
export function announceEquipmentStatus(store, { scope, status, reason_category, reason_detail, effective_from = now(), effective_to = null, source }) {
  if (!scope?.product_id) throw new DomainError(ErrorCodes.VALIDATION, "公告需要 scope.product_id");
  if (!Object.values(EquipmentStatus).includes(status)) throw new DomainError(ErrorCodes.VALIDATION, `未知设备状态 ${status}`);
  const aggregateType = scope.slot_id ? "experience_slot" : "experience_product";
  const aggregateId = scope.slot_id ? `${scope.product_id}/${scope.slot_id}` : scope.product_id;
  const version = store.eventsForAggregate(aggregateType, aggregateId).length + 1;

  const event = {
    event_id: newId("evt"),
    event_type: "EQUIPMENT_STATUS_ANNOUNCED",
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: now(),
    version,
    summary: `${aggregateId} 设备状态 ${status}（${reason_category}）`,
    source,
    payload: { scope, status, reason_category, reason_detail: reason_detail ?? null, effective_from, effective_to },
  };
  store.append(event, version - 1);
  return event;
}

/** 设备状态读模型：给出产品/时段当前是否处于停运及原因。 */
export class EquipmentView {
  // key(scope) -> 最新公告负载
  #status = new Map();

  apply(event) {
    if (event.event_type !== "EQUIPMENT_STATUS_ANNOUNCED") return;
    const { scope } = event.payload;
    this.#status.set(scopeKey(scope), event.payload);
  }

  /** 返回生效中的停运公告（精确时段优先，其次产品级）；正常时返回 null。 */
  activeOutage(product, slot, at = now()) {
    const exact = this.#status.get(scopeKey({ product_id: product.product_id, slot_id: slot.slot_id }));
    const broad = this.#status.get(scopeKey({ product_id: product.product_id }));
    for (const announcement of [exact, broad]) {
      if (announcement?.status === EquipmentStatus.OUTAGE && inEffect(announcement, at)) return announcement;
    }
    return null;
  }

  statusOf(productId, slotId = null) {
    return this.#status.get(scopeKey({ product_id: productId, slot_id: slotId })) ?? null;
  }
}

function scopeKey(scope) {
  return scope.slot_id ? `${scope.product_id}/${scope.slot_id}` : scope.product_id;
}

function inEffect(announcement, at) {
  const t = Date.parse(at);
  return t >= Date.parse(announcement.effective_from) && (announcement.effective_to === null || t <= Date.parse(announcement.effective_to));
}
