// 预订服务：组合行程的生命周期。
//
// 行程行状态机（各行独立，保留各供应商自己的确认权）：
//   REQUESTED ──供应商确认──▶ CONFIRMED ──签到──▶ CHECKED_IN
//        ├────供应商拒绝────▶ REJECTED                 └──现场拒绝──▶ ADMISSION_DENIED
//        ├────平台超时──────▶ TIMED_OUT        CONFIRMED ──停运──▶ INTERRUPTED ──同意替换──▶ REPLACED
//        └────同行失败连带─▶ CANCELLED
//
// 关键幂等点：
//   - 供应商回调一律走 NotificationGateway（重复/过期回调不生效）；
//   - 每个 item_id 只允许一次状态跃迁；迟到确认在 TIMED_OUT 之后被拒；
//   - 离线签到用固定幂等键 checkin:<bundle>:<item>，断网重传/重复回调只产生一次签到、一次请款；
//   - 只有全部供应商确认后才授权并 BUNDLE_CONFIRMED；任何一行失败即整单取消，不请款。

import { DomainError, ErrorCodes } from "./errors.js";
import { now, newId } from "./runtime.js";
import { evaluateEligibility, failedRules, validateTransport } from "./eligibility.js";

export const ItemState = Object.freeze({
  REQUESTED: "REQUESTED",
  CONFIRMED: "CONFIRMED",
  REJECTED: "REJECTED",
  TIMED_OUT: "TIMED_OUT",
  CANCELLED: "CANCELLED",
  CHECKED_IN: "CHECKED_IN",
  ADMISSION_DENIED: "ADMISSION_DENIED",
  INTERRUPTED: "INTERRUPTED",
  REPLACED: "REPLACED",
});

const SETTLED = new Set(["REJECTED", "TIMED_OUT", "CANCELLED"]);

export class BookingService {
  #store;
  #catalog;
  #equipment;
  #payments;
  #gateway;
  #assertionsOf; // (touristId) => assertions[]

  constructor({ store, catalog, equipment, payments, gateway, assertionsOf }) {
    this.#store = store;
    this.#catalog = catalog;
    this.#equipment = equipment;
    this.#payments = payments;
    this.#gateway = gateway;
    this.#assertionsOf = assertionsOf;
  }

  /**
   * 发起组合行程：确认前统一验证资格、交通缓冲、库存、设备状态。
   * @returns {{bundleId:string, precheck:object, requestedEvent:object}}
   */
  requestBundle({ tourist_id, lines, transport = {}, safety_acks = {}, idempotency_key }) {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new DomainError(ErrorCodes.VALIDATION, "至少选择一个体验项目");
    }
    // 客户端幂等键：同一请求重放直接返回既有行程。
    if (idempotency_key) {
      const existing = BookingView.findByRequestKey(this.#store, idempotency_key);
      if (existing) return existing;
    }

    const assertions = this.#assertionsOf(tourist_id);
    const planned = [];
    const precheck = [];

    for (const line of lines) {
      const { product, slot } = this.#catalog.findSlot(line.product_id, line.slot_id);
      const eligibility = evaluateEligibility(product, assertions, { safetyAcks: safety_acks });
      const down = this.#equipment.activeOutage(product, slot);
      const seatsLeft = slot.available_seats ?? slot.capacity ?? 0;
      precheck.push({
        item_id: line.item_id,
        product_id: product.product_id,
        supplier_id: product.supplier_id,
        eligibility,
        equipment_down: Boolean(down),
        outage: down,
        seats_left: seatsLeft,
        restrictions_summary: summarizeRestrictions(product, eligibility, down),
      });
      planned.push({ item_id: line.item_id, product, slot });
    }

    const transportViolations = validateTransport(planned, transport);
    const problems = [];
    for (const check of precheck) {
      const fails = failedRules(check.eligibility);
      if (fails.length) problems.push({ kind: "eligibility", item_id: check.item_id, failures: fails });
      if (check.equipment_down) problems.push({ kind: "equipment_down", item_id: check.item_id, outage: check.outage });
      if (check.seats_left <= 0) problems.push({ kind: "inventory", item_id: check.item_id });
    }
    if (transportViolations.length) problems.push({ kind: "transport", violations: transportViolations });
    if (problems.length) {
      throw new DomainError(ErrorCodes.ELIGIBILITY, "组合行程未通过确认前校验", { problems, precheck });
    }

    const bundleId = newId("bundle");
    const total = { amount: planned.reduce((s, x) => s + x.product.price.amount, 0), currency: "CNY" };
    const requestVersion = this.#bundleVersion(bundleId);
    const requestedEvent = this.#append(bundleId, requestVersion + 1, "BUNDLE_REQUESTED", `游客 ${tourist_id} 请求组合行程 ${bundleId}`, {
      bundle_id: bundleId,
      tourist_id,
      items: planned.map((x) => ({ item_id: x.item_id, product_id: x.product.product_id, slot_id: x.slot_id })),
      total,
      transport,
      idempotency_key: idempotency_key ?? null,
    });

    for (const x of planned) {
      this.#appendItem(bundleId, x.item_id, 1, "ITEM_REQUESTED", `向 ${x.product.supplier_id} 请求确认 ${x.item_id}`, {
        bundle_id: bundleId,
        item_id: x.item_id,
        product_id: x.product.product_id,
        slot_id: x.slot_id,
        supplier_id: x.product.supplier_id,
        price: x.product.price,
        state: ItemState.REQUESTED,
      });
    }
    return { bundleId, precheck, requestedEvent };
  }

  /** 供应商确认/拒绝回调（经通知网关去重与版本把关，保留供应商确认权）。 */
  supplierRespond(notice) {
    const view = this.view(notice.bundle_id);
    const item = view.items.get(notice.item_id);
    if (!item) throw new DomainError(ErrorCodes.UNKNOWN_ITEM, "回调指向未知行程行", notice);
    const product = this.#catalog.get(item.product_id);
    if (notice.supplier_id !== product.supplier_id) {
      throw new DomainError(ErrorCodes.VALIDATION, "只有该项目的供应商可以确认本行", {
        expected: product.supplier_id,
        got: notice.supplier_id,
      });
    }
    const kind = notice.kind === "confirm" || notice.kind === "reject" ? notice.kind : null;
    if (!kind) throw new DomainError(ErrorCodes.VALIDATION, "供应商回调 kind 必须是 confirm/reject");

    return this.#gateway.ingest(
      {
        supplier_id: notice.supplier_id,
        notification_id: notice.notification_id,
        source_version: notice.source_version,
        occurred_at: notice.occurred_at,
        stream: `item:${notice.bundle_id}/${notice.item_id}`,
        kind,
        data: { reason: notice.reason },
      },
      () => {
        if (kind === "confirm") this.#markSupplierConfirmed(view, item);
        else this.#markSupplierRejected(view, item, notice.reason ?? "供应商拒绝");
      }
    );
  }

  /** 平台等待供应商超时（由 SLA 时钟触发，非外部回调）。 */
  supplierTimeout(bundleId, itemId, reason = "供应商确认超时") {
    const view = this.view(bundleId);
    const item = view.items.get(itemId);
    if (!item) throw new DomainError(ErrorCodes.UNKNOWN_ITEM, "未知行程行", { bundle_id: bundleId, item_id: itemId });
    if (item.state !== ItemState.REQUESTED) {
      return { ignored: true, state: item.state }; // 已确认/拒绝后的超时调度不生效
    }
    const event = this.#appendItem(bundleId, itemId, item.version + 1, "SUPPLIER_TIMEOUT", `行 ${itemId} 供应商确认超时`, {
      bundle_id: bundleId,
      item_id: itemId,
      supplier_id: item.supplier_id,
      reason,
      state: ItemState.TIMED_OUT,
    });
    view.applyItem(event);
    this.#settleAfterFailure(view);
  }

  #markSupplierConfirmed(view, item) {
    if (item.state === ItemState.CONFIRMED) return;
    if (item.state !== ItemState.REQUESTED) {
      // 超时/拒绝后的迟到确认：通知已留痕，但不得改状态。
      throw new DomainError(ErrorCodes.ILLEGAL_STATE, `行当前为 ${item.state}，迟到确认无效`, {
        item_id: item.item_id,
        state: item.state,
      });
    }
    const event = this.#appendItem(view.bundleId, item.item_id, item.version + 1, "SUPPLIER_CONFIRMED", `供应商 ${item.supplier_id} 确认 ${item.item_id}`, {
      bundle_id: view.bundleId,
      item_id: item.item_id,
      supplier_id: item.supplier_id,
      state: ItemState.CONFIRMED,
    });
    view.applyItem(event);
    this.#tryConfirmBundle(view);
  }

  #markSupplierRejected(view, item, reason) {
    if (SETTLED.has(item.state)) return;
    const event = this.#appendItem(view.bundleId, item.item_id, item.version + 1, "SUPPLIER_REJECTED", `供应商拒绝 ${item.item_id}：${reason}`, {
      bundle_id: view.bundleId,
      item_id: item.item_id,
      supplier_id: item.supplier_id,
      reason,
      state: ItemState.REJECTED,
    });
    view.applyItem(event);
    this.#settleAfterFailure(view);
  }

  #tryConfirmBundle(view) {
    if (view.status !== "REQUESTED") return;
    if ([...view.items.values()].every((i) => i.state === ItemState.CONFIRMED)) {
      const total = { amount: [...view.items.values()].reduce((s, i) => s + i.price.amount, 0), currency: "CNY" };
      const event = this.#append(view.bundleId, view.version + 1, "BUNDLE_CONFIRMED", `组合行程 ${view.bundleId} 全部供应商已确认`, {
        bundle_id: view.bundleId,
        item_ids: [...view.items.keys()],
        total,
      });
      view.applyBundle(event);
      // 确认后一次性授权冻结（幂等键由平台派生，重复调度安全）。
      this.#payments.authorize(view.bundleId, total, `auth:${view.bundleId}`);
    }
  }

  #settleAfterFailure(view) {
    if (view.status !== "REQUESTED") return;
    const items = [...view.items.values()];
    if (!items.some((i) => SETTLED.has(i.state))) return;
    // 有一行失败：连带取消仍在等待的其他行，整单取消，不授权、不请款。
    for (const other of items) {
      if (other.state === ItemState.REQUESTED) {
        const event = this.#appendItem(view.bundleId, other.item_id, other.version + 1, "ITEM_CANCELLED", `因同行失败连带取消 ${other.item_id}`, {
          bundle_id: view.bundleId,
          item_id: other.item_id,
          reason: "同行项目被拒或超时，整单取消",
          state: ItemState.CANCELLED,
        });
        view.applyItem(event);
      }
    }
    const event = this.#append(view.bundleId, view.version + 1, "BUNDLE_CANCELLED", `组合行程 ${view.bundleId} 取消`, {
      bundle_id: view.bundleId,
      reason: "存在供应商拒绝或超时",
    });
    view.applyBundle(event);
  }

  /**
   * 签到（支持离线）：evidence_ref 指向现场证据保险柜；offline=true 表示补传。
   * 固定幂等键保证断网重传/重复回调只签到、请款各一次。
   */
  recordCheckin({ bundle_id, item_id, tourist_id, method, evidence_ref, recorded_at = now(), offline = false }) {
    const view = this.view(bundle_id);
    const item = view.items.get(item_id);
    if (!item) throw new DomainError(ErrorCodes.UNKNOWN_ITEM, "未知行程行", { bundle_id, item_id });
    if (item.state === ItemState.CHECKED_IN) {
      return { duplicate: true, event: item.checkinEvent };
    }
    if (item.state !== ItemState.CONFIRMED) {
      throw new DomainError(ErrorCodes.ILLEGAL_STATE, `行状态 ${item.state} 不能签到`, { item_id, state: item.state });
    }
    if (!evidence_ref) throw new DomainError(ErrorCodes.VALIDATION, "签到必须留存证据引用 evidence_ref");

    const event = this.#appendItem(bundle_id, item_id, item.version + 1, "CHECKIN_RECORDED", `${item_id} 已签到（${method}${offline ? "，离线补传" : ""}）`, {
      bundle_id,
      item_id,
      tourist_id,
      method,
      recorded_at,
      evidence_ref,
      offline,
      state: ItemState.CHECKED_IN,
    });
    // 履约发生，请款；幂等键与行程行绑定，任何重放都不会重复扣款。
    this.#payments.capture(bundle_id, item_id, item.price, `capture:${bundle_id}:${item_id}`);
    return { duplicate: false, event };
  }

  /** 现场拒绝入场：记录拒绝原因码（资格/设备/语言…），进入事故与退款流程。 */
  recordAdmissionDenied({ bundle_id, item_id, tourist_id, reason_code, reason_detail, rule_id, recorded_at = now(), evidence_ref }) {
    const view = this.view(bundle_id);
    const item = view.items.get(item_id);
    if (!item) throw new DomainError(ErrorCodes.UNKNOWN_ITEM, "未知行程行", { bundle_id, item_id });
    if (item.state === ItemState.ADMISSION_DENIED) return { duplicate: true, event: item.deniedEvent };
    // 入场当时或履约中途（已签到）都可能被现场拒绝，后者按部分履约处理。
    if (![ItemState.CONFIRMED, ItemState.CHECKED_IN].includes(item.state)) {
      throw new DomainError(ErrorCodes.ILLEGAL_STATE, `行状态 ${item.state} 不能记录拒绝入场`, { item_id, state: item.state });
    }
    const event = this.#appendItem(bundle_id, item_id, item.version + 1, "ADMISSION_DENIED", `${item_id} 现场拒绝入场：${reason_code}`, {
      bundle_id,
      item_id,
      tourist_id,
      reason_code,
      reason_detail,
      rule_id: rule_id ?? null,
      recorded_at,
      evidence_ref: evidence_ref ?? null,
      state: ItemState.ADMISSION_DENIED,
    });
    return { duplicate: false, event };
  }

  view(bundleId) {
    const view = new BookingView(bundleId);
    for (const e of this.#store.eventsForAggregate("booking_bundle", bundleId)) view.applyBundle(e);
    for (const e of this.#store.all().filter((x) => x.aggregate_type === "booking_item" && x.payload?.bundle_id === bundleId)) {
      view.applyItem(e);
    }
    return view;
  }

  #append(bundleId, version, type, summary, payload) {
    const event = {
      event_id: newId("evt"),
      event_type: type,
      aggregate_type: "booking_bundle",
      aggregate_id: bundleId,
      occurred_at: now(),
      version,
      summary,
      payload,
    };
    this.#store.append(event, version - 1);
    return event;
  }

  #appendItem(bundleId, itemId, version, type, summary, payload) {
    const event = {
      event_id: newId("evt"),
      event_type: type,
      aggregate_type: "booking_item",
      aggregate_id: `${bundleId}/${itemId}`,
      occurred_at: now(),
      version,
      summary,
      payload,
    };
    this.#store.append(event, version - 1);
    return event;
  }

  #bundleVersion(bundleId) {
    return this.#store.eventsForAggregate("booking_bundle", bundleId).length;
  }
}

/** 组合行程读模型（服务内快照，视图层也复用它）。 */
export class BookingView {
  constructor(bundleId) {
    this.bundleId = bundleId;
    this.version = 0;
    this.tourist_id = null;
    this.transport = null;
    this.items = new Map();
    this.status = "NEW";
    this.request_key = null;
  }

  applyBundle(event) {
    this.version = event.version;
    if (event.event_type === "BUNDLE_REQUESTED") {
      this.status = "REQUESTED";
      this.tourist_id = event.payload.tourist_id;
      this.transport = event.payload.transport;
      this.request_key = event.payload.idempotency_key;
    } else if (event.event_type === "BUNDLE_CONFIRMED") this.status = "CONFIRMED";
    else if (event.event_type === "BUNDLE_CANCELLED") this.status = "CANCELLED";
  }

  applyItem(event) {
    const p = event.payload;
    const item = this.items.get(p.item_id) ?? {
      item_id: p.item_id,
      product_id: p.product_id,
      slot_id: p.slot_id,
      supplier_id: p.supplier_id,
      price: p.price,
      version: 0,
      state: "NEW",
      timeline: [],
    };
    item.version = event.version;
    if (p.state) item.state = p.state;
    item.timeline.push({ at: event.occurred_at, event_type: event.event_type, version: event.version, payload: p });
    if (event.event_type === "CHECKIN_RECORDED") item.checkinEvent = event;
    if (event.event_type === "ADMISSION_DENIED") item.deniedEvent = event;
    this.items.set(p.item_id, item);
  }

  freeze() {
    for (const item of this.items.values()) Object.freeze(item);
  }

  static findByRequestKey(store, key) {
    for (const e of store.all()) {
      if (e.event_type === "BUNDLE_REQUESTED" && e.payload.idempotency_key === key) {
        return { bundleId: e.aggregate_id, requestedEvent: e, precheck: [], idempotentReplay: true };
      }
    }
    return null;
  }
}

/** 游客可读的限制摘要（出发前展示）。 */
export function summarizeRestrictions(product, eligibilityResults, outage) {
  return {
    product_id: product.product_id,
    title: product.title,
    real_name_required: product.eligibility_rules.some((r) => r.type === "real_name_required"),
    age_limits: product.eligibility_rules
      .filter((r) => r.type === "min_age" || r.type === "max_age")
      .map((r) => (r.type === "min_age" ? `≥${r.min_age}岁` : `≤${r.max_age}岁`)),
    adult_accompaniment: product.eligibility_rules
      .filter((r) => r.type === "adult_accompaniment_required")
      .map((r) => `${r.adult_required_under}岁以下须成人陪同`),
    on_site_languages: product.languages,
    safety_notice_version: product.safety_notice?.version ?? null,
    equipment_status: outage ? `停运：${outage.reason_category}` : "正常",
    unmet: eligibilityResults.filter((r) => !r.passed).map((r) => ({ rule_id: r.rule_id, reason_code: r.reason_code, message: r.message })),
  };
}
