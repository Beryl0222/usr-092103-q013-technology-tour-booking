// 事故与替换服务：
//  - 无人车/无人机/机器人门店/智能工厂临时停运（或现场拒绝）开事故单；
//  - 分级升级（供应商一线 → 平台值班 → 应急），SLA 超时自动升级，全程留痕；
//  - 替换方案以不可变报价（quote_version）提供，游客须按该版本重新明确同意；
//    未同意、同意过期版本、或拒绝替换，均不得自动改约或扣款；
//  - 接受/拒绝后按合同条款对该行计算部分履约退款并登记责任方。

import { DomainError, ErrorCodes } from "./errors.js";
import { now, newId } from "./runtime.js";
import { ItemState } from "./bookings.js";
import { computeItemRefund } from "./refunds.js";

export const EscalationLevel = Object.freeze({
  L1_SUPPLIER: "L1_SUPPLIER",
  L2_PLATFORM_DUTY: "L2_PLATFORM_DUTY",
  L3_EMERGENCY: "L3_EMERGENCY",
});

const LEVEL_ORDER = [EscalationLevel.L1_SUPPLIER, EscalationLevel.L2_PLATFORM_DUTY, EscalationLevel.L3_EMERGENCY];

// 各级处理时限（分钟）。
const DEFAULT_SLA_MINUTES = {
  L1_SUPPLIER: 30,
  L2_PLATFORM_DUTY: 60,
  L3_EMERGENCY: null,
};

export class IncidentService {
  #store;
  #catalog;
  #payments;

  constructor({ store, catalog, payments }) {
    this.#store = store;
    this.#catalog = catalog;
    this.#payments = payments;
  }

  /**
   * 开事故单。
   * @param {object} p
   * @param {Array<{bundle_id:string, item_id:string}>} p.items 受影响的行程行
   * @param {string} p.reason_category 例如 EQUIPMENT_OUTAGE / ADMISSION_DENIED / WEATHER
   * @param {'LOW'|'MEDIUM'|'HIGH'} p.severity
   * @param {string} [p.linked_event_id] 触发事件（设备公告或拒绝入场），供客服串联
   */
  open({ items, reason_category, severity = "MEDIUM", reason_detail = null, linked_event_id = null }) {
    if (!Array.isArray(items) || items.length === 0) throw new DomainError(ErrorCodes.VALIDATION, "事故至少关联一个行程行");
    const incidentId = newId("inc");
    const openedAt = now();
    const event = {
      event_id: newId("evt"),
      event_type: "SERVICE_INTERRUPTED",
      aggregate_type: "service_incident",
      aggregate_id: incidentId,
      occurred_at: openedAt,
      version: 1,
      summary: `事故 ${incidentId}：${reason_category}，影响 ${items.length} 个行程行`,
      payload: {
        incident_id: incidentId,
        items,
        reason_category,
        reason_detail,
        severity,
        linked_event_id,
        opened_at: openedAt,
        status: "OPEN",
      },
    };
    this.#store.append(event, 0);

    // 受影响且仍有效的行程行进入 INTERRUPTED（已签到的部分履约行同样挂起等待处置）。
    for (const ref of items) {
      const item = this.#itemEventTail(ref.bundle_id, ref.item_id);
      if (item && [ItemState.CONFIRMED, ItemState.CHECKED_IN].includes(item.payload.state)) {
        this.#appendItemEvent(ref.bundle_id, ref.item_id, item.version + 1, "ITEM_INTERRUPTED", {
          bundle_id: ref.bundle_id,
          item_id: ref.item_id,
          incident_id: incidentId,
          reason: `事故 ${incidentId} 中断，等待处置`,
          state: ItemState.INTERRUPTED,
        });
      }
    }

    // 立即建立一级升级。
    this.escalate(incidentId, { to_level: EscalationLevel.L1_SUPPLIER, note: "开单即派供应商一线", at: openedAt });
    return this.view(incidentId);
  }

  /** 升级到指定级别（或按当前级别顺延一级）。 */
  escalate(incidentId, { to_level = null, note = "", at = now() } = {}) {
    const view = this.view(incidentId);
    if (!view.exists) throw new DomainError(ErrorCodes.UNKNOWN_INCIDENT, "未知事故", { incident_id: incidentId });
    const current = view.escalations.at(-1)?.level ?? null;
    const next = to_level ?? (current ? LEVEL_ORDER[Math.min(LEVEL_ORDER.indexOf(current) + 1, LEVEL_ORDER.length - 1)] : LEVEL_ORDER[0]);
    if (current && LEVEL_ORDER.indexOf(next) <= LEVEL_ORDER.indexOf(current)) {
      return view; // 不允许降级或重复同级
    }
    const sla = DEFAULT_SLA_MINUTES[next];
    const event = {
      event_id: newId("evt"),
      event_type: "INCIDENT_ESCALATED",
      aggregate_type: "service_incident",
      aggregate_id: incidentId,
      occurred_at: at,
      version: view.version + 1,
      summary: `事故 ${incidentId} 升级至 ${next}`,
      payload: {
        incident_id: incidentId,
        level: next,
        to_role: roleFor(next),
        note,
        due_at: sla === null ? null : new Date(Date.parse(at) + sla * 60000).toISOString(),
      },
    };
    this.#store.append(event, view.version);
    return this.view(incidentId);
  }

  /** SLA 时钟：对所有已逾期但未到更高级别的事故自动升级。返回本次升级的事故。 */
  autoEscalateDue(at = now()) {
    const due = [];
    for (const id of this.allOpenIncidentIds()) {
      const view = this.view(id);
      const top = view.escalations.at(-1);
      if (top?.due_at && Date.parse(at) > Date.parse(top.due_at) && top.level !== EscalationLevel.L3_EMERGENCY) due.push(id);
    }
    for (const id of due) this.escalate(id, { note: "超过处理时限自动升级", at });
    return due;
  }

  /**
   * 提供替换方案（不可变报价）。无人车/工厂类停运必须走这里取得游客重新同意。
   * @param {object} quote {{product_id, slot_id, price, supplier_id}}
   */
  offerReplacement(incidentId, { bundle_id, item_id, quote, ttl_minutes = 24 * 60, at = now() }) {
    const view = this.view(incidentId);
    if (!view.exists) throw new DomainError(ErrorCodes.UNKNOWN_INCIDENT, "未知事故", { incident_id: incidentId });
    if (!quote?.product_id || !quote?.slot_id || !quote?.price) {
      throw new DomainError(ErrorCodes.VALIDATION, "替换报价需要 product_id/slot_id/price");
    }
    // 校验替换目标确实存在且当前可约。
    this.#catalog.findSlot(quote.product_id, quote.slot_id);

    const quoteVersion = `Q-${incidentId}-${view.offers.length + 1}`;
    const expiresAt = new Date(Date.parse(at) + ttl_minutes * 60000).toISOString();
    const event = {
      event_id: newId("evt"),
      event_type: "REPLACEMENT_OFFERED",
      aggregate_type: "service_incident",
      aggregate_id: incidentId,
      occurred_at: at,
      version: view.version + 1,
      summary: `事故 ${incidentId} 对 ${item_id} 给出替换报价 ${quoteVersion}`,
      payload: {
        incident_id: incidentId,
        bundle_id,
        item_id,
        quote,
        quote_version: quoteVersion,
        expires_at: expiresAt,
      },
    };
    this.#store.append(event, view.version);
    return this.view(incidentId);
  }

  /**
   * 游客接受替换：consent.quote_version 必须与当前待决报价一致，且在有效期内。
   * 接受后原行程行按替换差额/条款结算，行状态转 REPLACED。
   */
  acceptReplacement(incidentId, { bundle_id, item_id, consent, clause_key = "supplier_outage_replacement", at = now() }) {
    const view = this.view(incidentId);
    const offer = this.#pendingOffer(view, bundle_id, item_id);
    if (!consent || consent.quote_version !== offer.quote_version) {
      throw new DomainError(ErrorCodes.QUOTE_MISMATCH, "同意必须针对当前替换报价版本", {
        expected: offer.quote_version,
        got: consent?.quote_version,
      });
    }
    if (Date.parse(at) > Date.parse(offer.expires_at)) {
      throw new DomainError(ErrorCodes.CONSENT_REQUIRED, "替换报价已过期，须重新报价并取得同意", {
        quote_version: offer.quote_version,
      });
    }

    this.#appendIncident(incidentId, view.version + 1, "REPLACEMENT_ACCEPTED", at, `游客接受替换 ${offer.quote_version}`, {
      incident_id: incidentId,
      bundle_id,
      item_id,
      quote_version: offer.quote_version,
      consent,
      quote: offer.quote,
    });
    this.#transitionItem(bundle_id, item_id, ItemState.REPLACED, `接受替换报价 ${offer.quote_version}`, offer.quote_version);
    this.#settleRefund(bundle_id, item_id, clause_key);
    this.resolve(incidentId, { outcome: "REPLACED_WITH_CONSENT", at });
    return this.view(incidentId);
  }

  /** 游客拒绝替换：原行取消，按供应商停运条款退款。 */
  declineReplacement(incidentId, { bundle_id, item_id, reason = "游客拒绝替换", clause_key = "supplier_outage_cancel", at = now() }) {
    const view = this.view(incidentId);
    const offer = this.#pendingOffer(view, bundle_id, item_id);
    this.#appendIncident(incidentId, view.version + 1, "REPLACEMENT_DECLINED", at, `游客拒绝替换 ${offer.quote_version}`, {
      incident_id: incidentId,
      bundle_id,
      item_id,
      quote_version: offer.quote_version,
      reason,
    });
    this.#transitionItem(bundle_id, item_id, ItemState.CANCELLED, `拒绝替换，原行取消：${reason}`);
    this.#settleRefund(bundle_id, item_id, clause_key);
    this.resolve(incidentId, { outcome: "REFUNDED_AFTER_DECLINE", at });
    return this.view(incidentId);
  }

  /** 不提供替换（如现场拒绝入场）：直接按条款结算该行退款并关单。 */
  resolveWithRefund(incidentId, { bundle_id, item_id, clause_key = "partial_performance", outcome = "PARTIAL_PERFORMANCE_REFUNDED", at = now() }) {
    const view = this.view(incidentId);
    if (!view.exists) throw new DomainError(ErrorCodes.UNKNOWN_INCIDENT, "未知事故", { incident_id: incidentId });
    this.#settleRefund(bundle_id, item_id, clause_key);
    this.resolve(incidentId, { outcome, at });
    return this.view(incidentId);
  }

  resolve(incidentId, { outcome, at = now() }) {
    const view = this.view(incidentId);
    const event = {
      event_id: newId("evt"),
      event_type: "INCIDENT_RESOLVED",
      aggregate_type: "service_incident",
      aggregate_id: incidentId,
      occurred_at: at,
      version: view.version + 1,
      summary: `事故 ${incidentId} 解决：${outcome}`,
      payload: { incident_id: incidentId, outcome, status: "RESOLVED" },
    };
    this.#store.append(event, view.version);
    return this.view(incidentId);
  }

  #pendingOffer(view, bundleId, itemId) {
    const offers = view.offers.filter((o) => o.bundle_id === bundleId && o.item_id === itemId);
    const latest = offers.at(-1);
    if (!latest) throw new DomainError(ErrorCodes.INVALID_PAYLOAD, "该行没有待决的替换报价");
    const decided = view.decisions.some((d) => d.item_id === itemId && d.quote_version === latest.quote_version);
    if (decided) throw new DomainError(ErrorCodes.ILLEGAL_STATE, "该报价已有决定", { quote_version: latest.quote_version });
    return latest;
  }

  #settleRefund(bundleId, itemId, clauseKey) {
    // 退款条款取自"原项目"合同：以最初的 ITEM_REQUESTED 记录为准，不受中断/替换事件影响。
    const originalProductId = this.#findOriginalProduct(bundleId, itemId);
    const product = this.#catalog.get(originalProductId);
    const payment = this.#payments.view(bundleId);
    const captured = payment.captures.filter((c) => c.item_id === itemId).reduce((s, c) => s + c.amount.amount, 0);
    const plan = computeItemRefund({
      product,
      clause_key: clauseKey,
      captured_amount: captured,
      responsible_party_override: product.supplier_id,
    });
    const refundEvent = this.#payments.allocateRefund(bundleId, {
      item_id: itemId,
      amount: plan.amount,
      responsible_party: plan.responsible_party,
      basis: plan.basis,
      status: plan.status,
    });
    return { plan, refundEvent };
  }

  #findOriginalProduct(bundleId, itemId) {
    const requested = this.#store
      .all()
      .find((e) => e.aggregate_type === "booking_item" && e.event_type === "ITEM_REQUESTED" && e.payload?.item_id === itemId && e.payload?.bundle_id === bundleId);
    return requested?.payload?.product_id;
  }

  #transitionItem(bundleId, itemId, newState, reason, quoteVersion = null) {
    const tail = this.#itemEventTail(bundleId, itemId);
    if (!tail) throw new DomainError(ErrorCodes.UNKNOWN_ITEM, "未知行程行", { bundle_id: bundleId, item_id: itemId });
    const isReplacement = newState === ItemState.REPLACED;
    const payload = {
      ...tail.payload,
      bundle_id: bundleId,
      item_id: itemId,
      reason,
      state: newState,
      ...(isReplacement ? { quote_version: quoteVersion } : {}),
    };
    this.#appendItemEvent(bundleId, itemId, tail.version + 1, isReplacement ? "ITEM_REPLACED" : "ITEM_CANCELLED", payload);
  }

  #appendIncident(incidentId, version, type, at, summary, payload) {
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: type,
        aggregate_type: "service_incident",
        aggregate_id: incidentId,
        occurred_at: at,
        version,
        summary,
        payload,
      },
      version - 1
    );
  }

  #appendItemEvent(bundleId, itemId, version, type, payload) {
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: type,
        aggregate_type: "booking_item",
        aggregate_id: `${bundleId}/${itemId}`,
        occurred_at: now(),
        version,
        summary: `${itemId} 状态转为 ${payload.state}`,
        payload,
      },
      version - 1
    );
  }

  #itemEventTail(bundleId, itemId) {
    const events = this.#store.eventsForAggregate("booking_item", `${bundleId}/${itemId}`);
    return events.at(-1) ?? null;
  }

  view(incidentId) {
    return IncidentView.build(this.#store, incidentId);
  }

  allOpenIncidentIds() {
    const ids = new Set();
    const resolved = new Set();
    for (const e of this.#store.all()) {
      if (e.aggregate_type === "service_incident") {
        ids.add(e.aggregate_id);
        if (e.event_type === "INCIDENT_RESOLVED") resolved.add(e.aggregate_id);
      }
    }
    return [...ids].filter((id) => !resolved.has(id));
  }
}

export class IncidentView {
  constructor(incidentId) {
    this.incident_id = incidentId;
    this.exists = false;
    this.version = 0;
    this.items = [];
    this.reason_category = null;
    this.severity = null;
    this.linked_event_id = null;
    this.status = "NEW";
    this.escalations = [];
    this.offers = [];
    this.decisions = [];
    this.resolution = null;
  }

  apply(event) {
    this.exists = true;
    this.version = event.version;
    const p = event.payload;
    if (event.event_type === "SERVICE_INTERRUPTED") {
      this.items = p.items;
      this.reason_category = p.reason_category;
      this.severity = p.severity;
      this.linked_event_id = p.linked_event_id;
      this.status = p.status;
      this.opened_at = p.opened_at;
    } else if (event.event_type === "INCIDENT_ESCALATED") {
      this.escalations.push({ level: p.level, to_role: p.to_role, at: event.occurred_at, due_at: p.due_at, note: p.note });
    } else if (event.event_type === "REPLACEMENT_OFFERED") {
      this.offers.push({ ...p, offered_at: event.occurred_at });
    } else if (event.event_type === "REPLACEMENT_ACCEPTED" || event.event_type === "REPLACEMENT_DECLINED") {
      this.decisions.push({ ...p, decided_at: event.occurred_at, kind: event.event_type === "REPLACEMENT_ACCEPTED" ? "ACCEPTED" : "DECLINED" });
    } else if (event.event_type === "INCIDENT_RESOLVED") {
      this.status = p.status;
      this.resolution = p.outcome;
    }
  }

  static build(store, incidentId) {
    const view = new IncidentView(incidentId);
    for (const e of store.eventsForAggregate("service_incident", incidentId)) view.apply(e);
    return view;
  }
}

function roleFor(level) {
  return {
    L1_SUPPLIER: "供应商现场负责人",
    L2_PLATFORM_DUTY: "旅行社平台值班经理",
    L3_EMERGENCY: "应急指挥与合规",
  }[level];
}
