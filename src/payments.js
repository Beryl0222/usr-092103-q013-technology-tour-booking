// 支付服务：一笔行程授权一次，按履约行请款；授权/请款/退款全部幂等。
// 重复支付回调、离线签到重传、供应商超时后的迟到确认，都不能造成第二次扣款：
//   - 相同 idempotency_key 返回首个结果；
//   - 每个履约行至多请款一次，且累计请款不得超过授权额与行价格；
//   - 退款按行累计不得超过该行已请款金额。

import { DomainError, ErrorCodes } from "./errors.js";
import { now, newId } from "./runtime.js";

export class PaymentService {
  #store;

  constructor(store) {
    this.#store = store;
  }

  /** 组合确认后一次性冻结额度（不扣款）。 */
  authorize(bundleId, amount, idempotencyKey) {
    const state = this.view(bundleId);
    if (state.authorized) {
      if (state.authorization_idempotency_key === idempotencyKey) return state.authorizedEvent;
      throw new DomainError(ErrorCodes.PAYMENT_STATE, "该行程已授权，授权键不一致", { bundle_id: bundleId });
    }
    const event = {
      event_id: newId("evt"),
      event_type: "PAYMENT_AUTHORIZED",
      aggregate_type: "payment",
      aggregate_id: bundleId,
      occurred_at: now(),
      version: 1,
      summary: `行程 ${bundleId} 授权冻结 ${amount.amount / 100} 元`,
      payload: {
        bundle_id: bundleId,
        payment_id: `pay_${bundleId}`,
        amount,
        authorization_id: `auth_${bundleId}`,
        idempotency_key: idempotencyKey,
      },
    };
    this.#store.append(event, 0);
    return event;
  }

  /** 履约行请款（签到成功后）。同一行同一键重复调用只生效一次。 */
  capture(bundleId, itemId, amount, idempotencyKey) {
    const state = this.view(bundleId);
    if (!state.authorized) throw new DomainError(ErrorCodes.PAYMENT_STATE, "尚未授权，不能请款", { bundle_id: bundleId });

    const existing = state.captures.find((c) => c.idempotency_key === idempotencyKey || c.item_id === itemId);
    if (existing) {
      if (existing.idempotency_key === idempotencyKey && existing.item_id === itemId) {
        return existing.event; // 幂等重放
      }
      throw new DomainError(ErrorCodes.PAYMENT_STATE, "履约行已请款或键冲突，拒绝重复扣款", {
        bundle_id: bundleId,
        item_id: itemId,
      });
    }
    if (amount.amount <= 0) throw new DomainError(ErrorCodes.INVALID_PAYLOAD, "请款金额必须为正数");
    const capturedTotal = state.captures.reduce((s, c) => s + c.amount.amount, 0);
    if (capturedTotal + amount.amount > state.authorized.amount.amount) {
      throw new DomainError(ErrorCodes.PAYMENT_STATE, "请款累计超过授权额", {
        authorized: state.authorized.amount.amount,
        captured: capturedTotal,
        requested: amount.amount,
      });
    }

    const event = {
      event_id: newId("evt"),
      event_type: "PAYMENT_CAPTURED",
      aggregate_type: "payment",
      aggregate_id: bundleId,
      occurred_at: now(),
      version: state.version + 1,
      summary: `行 ${itemId} 请款 ${amount.amount / 100} 元`,
      payload: { bundle_id: bundleId, item_id: itemId, amount, idempotency_key: idempotencyKey },
    };
    this.#store.append(event, state.version);
    return event;
  }

  /**
   * 登记退款分配（按合同计算后调用）。同一 refund_id 幂等；
   * 同一行累计退款不得超过已请款金额——未请款的行不需要退款（授权自动释放）。
   * @returns {object|null} 已登记的事件；未请款时返回 null（无款可退）
   */
  allocateRefund(bundleId, { refund_id = newId("ref"), item_id, amount, responsible_party, basis, status = "ALLOCATED" }) {
    const state = this.view(bundleId);
    const existing = state.refunds.find((r) => r.refund_id === refund_id);
    if (existing) return existing.event;

    const capturedForItem = state.captures.filter((c) => c.item_id === item_id).reduce((s, c) => s + c.amount.amount, 0);
    const refundedForItem = state.refunds.filter((r) => r.item_id === item_id).reduce((s, r) => s + r.amount.amount, 0);
    if (capturedForItem === 0 && status === "ALLOCATED") status = "AUTH_RELEASED_NO_CAPTURE";
    if (refundedForItem + amount.amount > capturedForItem) {
      throw new DomainError(ErrorCodes.PAYMENT_STATE, "退款超过该行已请款金额", {
        item_id,
        captured: capturedForItem,
        already_refunded: refundedForItem,
        requested: amount.amount,
      });
    }

    const event = {
      event_id: newId("evt"),
      event_type: "REFUND_ALLOCATED",
      aggregate_type: "payment",
      aggregate_id: bundleId,
      occurred_at: now(),
      version: state.version + 1,
      summary: `行 ${item_id} 退款 ${amount.amount / 100} 元，责任方 ${responsible_party}（${basis}）`,
      payload: {
        bundle_id: bundleId,
        refund_id,
        item_id,
        amount,
        responsible_party,
        basis,
        status,
      },
    };
    this.#store.append(event, state.version);
    return event;
  }

  view(bundleId) {
    return PaymentView.build(this.#store, bundleId);
  }
}

export class PaymentView {
  constructor() {
    this.version = 0;
    this.authorized = null;
    this.authorization_idempotency_key = null;
    this.authorizedEvent = null;
    this.captures = [];
    this.refunds = [];
  }

  apply(event) {
    if (event.aggregate_type !== "payment") return;
    this.version = event.version;
    if (event.event_type === "PAYMENT_AUTHORIZED") {
      this.authorized = event.payload.amount;
      this.authorization_idempotency_key = event.payload.idempotency_key;
      this.authorizedEvent = event;
    } else if (event.event_type === "PAYMENT_CAPTURED") {
      this.captures.push({ ...event.payload, event });
    } else if (event.event_type === "REFUND_ALLOCATED") {
      this.refunds.push({ ...event.payload, event });
    }
  }

  static build(store, bundleId) {
    const view = new PaymentView();
    for (const e of store.eventsForAggregate("payment", bundleId)) view.apply(e);
    return view;
  }
}
