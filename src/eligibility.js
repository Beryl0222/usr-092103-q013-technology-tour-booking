// 资格评估：把产品规则与游客的最小断言对照，输出逐条通过/失败结论。
// 规则只引用断言（不接触证件原件），客服可凭失败 rule_id 直接定位规则原文。

import { DomainError, ErrorCodes } from "./errors.js";
import { bufferMinutesBetween } from "./runtime.js";

/**
 * @returns {{rule_id, type, passed: boolean, reason_code?, message?}[]}
 */
export function evaluateEligibility(product, assertions, context = {}) {
  const valueOf = (key) => assertions.find((a) => a.key === key)?.value;
  const results = [];

  for (const rule of product.eligibility_rules) {
    switch (rule.type) {
      case "real_name_required": {
        results.push(check(rule, valueOf("real_name_verified") === true, "REAL_NAME_UNVERIFIED", "实名信息未通过核验"));
        break;
      }
      case "min_age": {
        const age = valueOf("age_years_at");
        results.push(check(rule, Number.isInteger(age) && age >= rule.min_age, "AGE_BELOW_MINIMUM", `须年满 ${rule.min_age} 周岁（当前断言 ${age}）`));
        break;
      }
      case "max_age": {
        const age = valueOf("age_years_at");
        results.push(check(rule, Number.isInteger(age) && age <= rule.max_age, "AGE_ABOVE_MAXIMUM", `超过 ${rule.max_age} 周岁上限`));
        break;
      }
      case "adult_accompaniment_required": {
        const age = valueOf("age_years_at");
        const needsAdult = Number.isInteger(age) && age < rule.adult_required_under;
        results.push(
          check(rule, !needsAdult || valueOf("accompanied_by_adult") === true, "NO_ADULT_COMPANION", `未满 ${rule.adult_required_under} 周岁须成人陪同`)
        );
        break;
      }
      case "document_validity_required": {
        results.push(check(rule, valueOf("document_not_expired") === true, "DOCUMENT_EXPIRED", "证件已过期或无法断言有效期"));
        break;
      }
      case "language_required": {
        const supported = rule.languages.some((lang) => {
          const level = valueOf(`language:${lang}`);
          return level !== undefined && meetsLevel(level, rule.min_level ?? "usable");
        });
        results.push(check(rule, supported, "LANGUAGE_UNSUPPORTED", `需要 ${rule.languages.join("/")} 的现场语言能力`));
        break;
      }
      case "safety_ack_required": {
        const acked = context.safetyAcks?.[product.product_id];
        results.push(
          check(
            rule,
            Boolean(acked) && acked.notice_version === product.safety_notice?.version,
            "SAFETY_NOTICE_NOT_ACKNOWLEDGED",
            `须确认安全告知版本 ${product.safety_notice?.version ?? "?"}`
          )
        );
        break;
      }
      default:
        results.push({ rule_id: rule.rule_id, type: rule.type, passed: false, reason_code: "UNKNOWN_RULE", message: `未知规则类型 ${rule.type}` });
    }
  }
  return results;
}

const LEVEL_ORDER = { none: 0, usable: 1, conversational: 2, fluent: 3, native: 4 };
function meetsLevel(actual, required) {
  return (LEVEL_ORDER[actual] ?? 1) >= (LEVEL_ORDER[required] ?? 1);
}

function check(rule, passed, reasonCode, message) {
  return passed
    ? { rule_id: rule.rule_id, type: rule.type, passed: true }
    : { rule_id: rule.rule_id, type: rule.type, passed: false, reason_code: reasonCode, message };
}

export function failedRules(results) {
  return results.filter((r) => !r.passed);
}

/**
 * 组合行程的交通缓冲校验：按时段开始时间排序，相邻两项之间的空档必须满足
 * 默认缓冲或显式 legs 中声明的缓冲（不同场地间通常更长）。
 *
 * @param {Array<{item_id:string, product:object, slot:object}>} planned
 * @param {{default_buffer_minutes?:number, legs?:Array<{after_item_id:string, buffer_minutes:number}>}} transport
 */
export function validateTransport(planned, transport = {}) {
  const def = transport.default_buffer_minutes ?? 0;
  const legByItem = new Map((transport.legs ?? []).map((l) => [l.after_item_id, l.buffer_minutes]));
  const ordered = [...planned].sort((a, b) => Date.parse(a.slot.start_at) - Date.parse(b.slot.start_at));
  const violations = [];

  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const next = ordered[i];
    const required = legByItem.get(prev.item_id) ?? def;
    const actual = bufferMinutesBetween(prev.slot.end_at, next.slot.start_at);
    if (actual < required) {
      violations.push({
        reason_code: "TRANSPORT_BUFFER_TOO_SHORT",
        from_item_id: prev.item_id,
        to_item_id: next.item_id,
        required_minutes: required,
        actual_minutes: actual,
        message: `${prev.item_id} → ${next.item_id} 交通缓冲 ${actual} 分钟，不足要求的 ${required} 分钟`,
      });
    }
  }
  return violations;
}

/** 组合确认前的统一预检抛错版本（资格 + 缓冲 + 库存 + 设备状态）。 */
export function assertBookable(checks) {
  const problems = [];
  for (const c of checks) {
    const fails = failedRules(c.eligibility ?? []);
    if (fails.length) problems.push({ kind: "eligibility", item_id: c.item_id, failures: fails });
    if (c.transport_violations?.length) problems.push({ kind: "transport", violations: c.transport_violations });
    if (c.seats_left !== undefined && c.seats_left <= 0) problems.push({ kind: "inventory", item_id: c.item_id });
    if (c.equipment_down) problems.push({ kind: "equipment_down", item_id: c.item_id });
  }
  if (problems.length) {
    throw new DomainError(ErrorCodes.ELIGIBILITY, "组合行程未通过确认前校验", { problems });
  }
}
