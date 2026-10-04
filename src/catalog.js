// 体验产品目录：项目时段、资格条件、安全告知、现场语言能力、价格与合同退款条款。
// EXPERIENCE_PUBLISHED 是产品当前报价版本的权威事件；库存与设备状态另有独立来源流。

import { ErrorCodes, DomainError } from "./errors.js";
import { now, newId } from "./runtime.js";

/** 发布或改版一个体验产品（产生新的 quote_version）。 */
export function publishProduct(store, product) {
  const errors = validateProduct(product);
  if (errors.length) throw new DomainError(ErrorCodes.VALIDATION, "产品资料不合法", { errors });

  const version = headVersion(store, product.product_id) + 1;
  const event = {
    event_id: newId("evt"),
    event_type: "EXPERIENCE_PUBLISHED",
    aggregate_type: "experience_product",
    aggregate_id: product.product_id,
    occurred_at: now(),
    version,
    summary: `发布体验 ${product.title}（${product.supplier_id}）报价版本 ${product.quote_version}`,
    payload: {
      product_id: product.product_id,
      supplier_id: product.supplier_id,
      title: product.title,
      quote_version: product.quote_version,
      location: product.location,
      price: product.price,
      slots: product.slots,
      eligibility_rules: product.eligibility_rules,
      safety_notice: product.safety_notice,
      languages: product.languages,
      contract: product.contract,
    },
  };
  store.append(event, version - 1);
  return event;
}

/** 供应商库存更新（独立通知流，版本由网关把关）。 */
export function recordInventory(store, productId, slotId, availableSeats, source) {
  const version = headVersion(store, `${productId}/${slotId}`) + 1;
  const event = {
    event_id: newId("evt"),
    event_type: "INVENTORY_UPDATED",
    aggregate_type: "experience_slot",
    aggregate_id: `${productId}/${slotId}`,
    occurred_at: now(),
    version,
    summary: `库存更新 ${productId}/${slotId}：可约 ${availableSeats}`,
    source,
    payload: { product_id: productId, slot_id: slotId, available_seats: availableSeats },
  };
  store.append(event, version - 1);
  return event;
}

function headVersion(store, id) {
  // 产品聚合按 product_id；时段聚合按 product/slot；分别统计。
  const aggregateType = id.includes("/") ? "experience_slot" : "experience_product";
  return store.eventsForAggregate(aggregateType, id).length;
}

function validateProduct(p) {
  const errors = [];
  for (const f of ["product_id", "supplier_id", "title", "quote_version", "price", "slots", "eligibility_rules", "languages", "contract"]) {
    if (!(f in p)) errors.push(`缺少 ${f}`);
  }
  if (p.price && (!Number.isInteger(p.price.amount) || p.price.amount < 0)) errors.push("price.amount 必须是非负整数");
  if (Array.isArray(p.slots)) {
    for (const s of p.slots) {
      if (!s.slot_id || !s.start_at || !s.end_at) errors.push(`时段 ${s.slot_id ?? "?"} 缺少 slot_id/start_at/end_at`);
      else if (Date.parse(s.end_at) <= Date.parse(s.start_at)) errors.push(`时段 ${s.slot_id} 结束时间必须晚于开始时间`);
      if (s.capacity !== undefined && (!Number.isInteger(s.capacity) || s.capacity < 0)) errors.push(`时段 ${s.slot_id} capacity 非法`);
    }
  }
  if (Array.isArray(p.eligibility_rules)) {
    for (const r of p.eligibility_rules) {
      if (!r.rule_id || !r.type) errors.push("资格规则缺少 rule_id/type");
      if (r.type === "min_age" && !Number.isInteger(r.min_age)) errors.push(`规则 ${r.rule_id} 缺少 min_age`);
      if (r.type === "language_required" && (!Array.isArray(r.languages) || r.languages.length === 0))
        errors.push(`规则 ${r.rule_id} 缺少 languages`);
    }
  }
  if (p.safety_notice && p.safety_notice.acknowledgement_required && !p.safety_notice.version) {
    errors.push("安全告知必须带 version 才能要求确认");
  }
  return errors;
}

/** 目录读模型：重放发布/库存事件得到当前产品与余位。 */
export class CatalogView {
  #products = new Map();

  apply(event) {
    if (event.event_type === "EXPERIENCE_PUBLISHED") {
      this.#products.set(event.aggregate_id, { ...event.payload, slots: event.payload.slots.map((s) => ({ ...s })) });
    } else if (event.event_type === "INVENTORY_UPDATED") {
      const product = this.#products.get(event.payload.product_id);
      const slot = product?.slots.find((s) => s.slot_id === event.payload.slot_id);
      if (slot) slot.available_seats = event.payload.available_seats;
    }
  }

  get(productId) {
    const p = this.#products.get(productId);
    if (!p) throw new DomainError(ErrorCodes.UNKNOWN_PRODUCT, `未知体验项目：${productId}`, { product_id: productId });
    return p;
  }

  findSlot(productId, slotId) {
    const product = this.get(productId);
    const slot = product.slots.find((s) => s.slot_id === slotId);
    if (!slot) throw new DomainError(ErrorCodes.UNKNOWN_ITEM, `未知时段：${productId}/${slotId}`);
    return { product, slot };
  }

  list() {
    return [...this.#products.values()];
  }
}
