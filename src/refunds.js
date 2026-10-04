// 退款策略：按合同条款与责任方对部分履约逐行计算退款，解决多供应商推诿。
// 退款对象是"已请款金额"；未请款（仅授权）的行金额为 0，授权自动释放，
// 但仍生成责任记录，保证客服能看到每一行由谁负责。

import { DomainError, ErrorCodes } from "./errors.js";

/**
 * @param {object} args
 * @param {object} args.product 目录产品（含 contract.terms_id / contract.clauses）
 * @param {string} args.clause_key 适用条款键
 * @param {number} args.captured_amount 该行已请款金额（分）
 * @param {string} [args.responsible_party_override] 事故判定的责任方（覆盖合同默认）
 * @param {object} [args.extra] 附加说明（如替换报价差额）
 */
export function computeItemRefund({ product, clause_key, captured_amount, responsible_party_override = null, extra = {} }) {
  const contract = product.contract;
  const clause = contract?.clauses?.[clause_key];
  if (!clause) {
    throw new DomainError(ErrorCodes.INVALID_PAYLOAD, `合同 ${contract?.terms_id ?? "?"} 缺少条款 ${clause_key}`, {
      product_id: product.product_id,
      clause_key,
    });
  }
  if (!Number.isInteger(captured_amount) || captured_amount < 0) {
    throw new DomainError(ErrorCodes.VALIDATION, "captured_amount 必须是非负整数（分）");
  }

  let ratio = clause.refund_ratio;
  if (typeof ratio !== "number" || ratio < 0 || ratio > 1) {
    throw new DomainError(ErrorCodes.INVALID_PAYLOAD, `条款 ${clause_key} 的 refund_ratio 必须在 0..1`);
  }
  const amount = Math.floor(captured_amount * ratio);
  return {
    amount: { amount, currency: "CNY" },
    responsible_party: responsible_party_override ?? clause.responsible_party ?? product.supplier_id,
    basis: `合同 ${contract.terms_id} 条款 ${clause_key}（退款比例 ${ratio}）`,
    clause_key,
    captured_amount,
    status: captured_amount === 0 ? "AUTH_RELEASED_NO_CAPTURE" : "ALLOCATED",
    ...extra,
  };
}
