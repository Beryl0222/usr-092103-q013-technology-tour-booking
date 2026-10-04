// 身份资料最小化：护照/证件原件信息不进入事件流，只转换为履约所必需的断言。
// 校验器会拒绝任何携带 passport/id_number 等字段的事件；本模块负责在入口完成转换。
//
// 允许进入事件流的仅是：
//   - 是否通过实名（real_name_verified）
//   - 证件类型（不含号码）
//   - 针对体验当日计算出的年龄（必要断言，用完即弃，不存出生日期）
//   - 证件是否在有效期内
//   - 语言能力、是否有成人陪同
// 原始资料留在证件保险柜 evidence_ref 指向的位置，供应商永远拿不到号码。

import { now, newId } from "./runtime.js";

export function deriveAssertions(profile, { at = now() } = {}) {
  if (!profile || !profile.tourist_id) throw new Error("deriveAssertions 需要 tourist_id");
  const assertions = [];
  const push = (key, value, required = true) => assertions.push({ key, value, required, asserted_at: at });

  push("real_name_verified", Boolean(profile.real_name_verified));
  if (profile.document_kind) push("document_kind", profile.document_kind);
  if (profile.date_of_birth) push("age_years_at", ageYears(profile.date_of_birth, at));
  if (profile.document_expiry_date) {
    push("document_not_expired", Date.parse(profile.document_expiry_date) > Date.parse(at));
  }
  if (Array.isArray(profile.languages)) {
    for (const lang of profile.languages) push(`language:${lang.code}`, lang.level ?? "usable", false);
  }
  if (profile.accompanied_by_adult !== undefined) {
    push("accompanied_by_adult", Boolean(profile.accompanied_by_adult), false);
  }
  return assertions.map((a) => ({ ...a, evidence_ref: profile.evidence_ref ?? "vault://identity/verified" }));
}

function ageYears(dobIso, atIso) {
  const dob = new Date(dobIso);
  const at = new Date(atIso);
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    at.getUTCMonth() < dob.getUTCMonth() ||
    (at.getUTCMonth() === dob.getUTCMonth() && at.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/** 将断言登记为 ELIGIBILITY_ASSERTED 事件（按游客聚合，版本递增）。 */
export function recordAssertions(store, touristId, assertions, scope = {}) {
  const version = store.eventsForAggregate("eligibility_assertion", touristId).length + 1;
  const event = {
    event_id: newId("evt"),
    event_type: "ELIGIBILITY_ASSERTED",
    aggregate_type: "eligibility_assertion",
    aggregate_id: touristId,
    occurred_at: now(),
    version,
    summary: `游客 ${touristId} 的身份断言已更新（${assertions.length} 项，仅必要断言）`,
    payload: {
      tourist_id: touristId,
      scope, // { product_id, slot_id } 或 {} 表示通用
      assertions,
    },
  };
  store.append(event, version - 1);
  return event;
}

export function latestAssertions(store, touristId) {
  const events = store.eventsForAggregate("eligibility_assertion", touristId);
  if (events.length === 0) return [];
  return events[events.length - 1].payload.assertions;
}
