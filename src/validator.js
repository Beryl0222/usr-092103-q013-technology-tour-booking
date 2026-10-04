// 领域事件公共校验：信封字段 + 按事件类型的最小负载形状。
// 不引入第三方依赖；校验结果为中文错误信息数组（空数组表示通过）。

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

const eventTypes = [
  "EXPERIENCE_PUBLISHED",
  "INVENTORY_UPDATED",
  "EQUIPMENT_STATUS_ANNOUNCED",
  "NOTIFICATION_RECORDED",
  "ELIGIBILITY_ASSERTED",
  "BUNDLE_REQUESTED",
  "ITEM_REQUESTED",
  "SUPPLIER_CONFIRMED",
  "SUPPLIER_REJECTED",
  "SUPPLIER_TIMEOUT",
  "ITEM_CANCELLED",
  "ITEM_INTERRUPTED",
  "ITEM_REPLACED",
  "BUNDLE_CONFIRMED",
  "BUNDLE_CANCELLED",
  "PAYMENT_AUTHORIZED",
  "PAYMENT_CAPTURED",
  "REFUND_ALLOCATED",
  "CHECKIN_RECORDED",
  "ADMISSION_DENIED",
  "SERVICE_INTERRUPTED",
  "INCIDENT_ESCALATED",
  "INCIDENT_RESOLVED",
  "REPLACEMENT_OFFERED",
  "REPLACEMENT_ACCEPTED",
  "REPLACEMENT_DECLINED",
];

const aggregateTypes = [
  "experience_product",
  "experience_slot",
  "supplier_notification",
  "eligibility_assertion",
  "booking_bundle",
  "booking_item",
  "payment",
  "service_incident",
  "refund",
];

// 事件类型 -> 负载必备字段（其余结构由领域服务保证）。
const payloadRequired = {
  EXPERIENCE_PUBLISHED: ["product_id", "supplier_id", "title", "slots", "eligibility_rules", "languages"],
  INVENTORY_UPDATED: ["product_id", "slot_id", "available_seats"],
  EQUIPMENT_STATUS_ANNOUNCED: ["scope", "status", "reason_category", "effective_from"],
  NOTIFICATION_RECORDED: ["supplier_id", "notification_id", "source_version", "disposition"],
  ELIGIBILITY_ASSERTED: ["tourist_id", "assertions"],
  BUNDLE_REQUESTED: ["bundle_id", "tourist_id", "items", "total", "transport"],
  ITEM_REQUESTED: ["bundle_id", "item_id", "product_id", "slot_id"],
  SUPPLIER_CONFIRMED: ["bundle_id", "item_id", "supplier_id"],
  SUPPLIER_REJECTED: ["bundle_id", "item_id", "supplier_id", "reason"],
  SUPPLIER_TIMEOUT: ["bundle_id", "item_id", "supplier_id", "reason"],
  ITEM_CANCELLED: ["bundle_id", "item_id", "reason"],
  ITEM_INTERRUPTED: ["bundle_id", "item_id", "reason", "incident_id", "state"],
  ITEM_REPLACED: ["bundle_id", "item_id", "quote_version", "state"],
  BUNDLE_CONFIRMED: ["bundle_id", "item_ids"],
  BUNDLE_CANCELLED: ["bundle_id", "reason"],
  PAYMENT_AUTHORIZED: ["bundle_id", "payment_id", "amount", "authorization_id", "idempotency_key"],
  PAYMENT_CAPTURED: ["bundle_id", "item_id", "amount", "idempotency_key"],
  REFUND_ALLOCATED: ["bundle_id", "refund_id", "item_id", "amount", "responsible_party", "basis", "status"],
  CHECKIN_RECORDED: ["bundle_id", "item_id", "tourist_id", "method", "recorded_at", "evidence_ref"],
  ADMISSION_DENIED: ["bundle_id", "item_id", "tourist_id", "reason_code", "recorded_at"],
  SERVICE_INTERRUPTED: ["incident_id", "reason_category", "severity"],
  INCIDENT_ESCALATED: ["incident_id", "level", "to_role"],
  INCIDENT_RESOLVED: ["incident_id", "outcome"],
  REPLACEMENT_OFFERED: ["bundle_id", "item_id", "incident_id", "quote", "quote_version", "expires_at"],
  REPLACEMENT_ACCEPTED: ["bundle_id", "item_id", "quote_version", "consent"],
  REPLACEMENT_DECLINED: ["bundle_id", "item_id", "quote_version", "reason"],
};

// 护照号、证件影像等原始敏感字段不得进入事件流；身份资料只能以断言+证据引用存在。
const sensitiveKeyPattern = /(passport|id_?card|id_?number|identity_?number|document_?image|raw_?document|phone_?number|home_?address)/i;

function collectSensitivePaths(value, path = "$", out = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectSensitivePaths(v, `${path}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (sensitiveKeyPattern.test(key)) out.push(`${path}.${key}`);
      collectSensitivePaths(v, `${path}.${key}`, out);
    }
  }
  return out;
}

function isDateString(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);

  if (record.event_type && !eventTypes.includes(record.event_type)) {
    errors.push(`未知 event_type：${record.event_type}`);
  }
  if (record.aggregate_type && !aggregateTypes.includes(record.aggregate_type)) {
    errors.push(`未知 aggregate_type：${record.aggregate_type}`);
  }
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("occurred_at" in record && !isDateString(record.occurred_at)) {
    errors.push("occurred_at 必须是合法的 date-time");
  }
  if ("source" in record) {
    if (!record.source || typeof record.source !== "object" || !record.source.system) {
      errors.push("source.system 不能为空");
    }
    if (record.source && "source_version" in record.source && (!Number.isInteger(record.source.source_version) || record.source.source_version < 1)) {
      errors.push("source.source_version 必须是正整数");
    }
  }

  const payload = record.payload;
  if (payload !== undefined) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      errors.push("payload 必须是对象");
    } else {
      const need = payloadRequired[record.event_type] ?? [];
      for (const name of need) {
        if (!(name in payload)) errors.push(`负载缺少字段：${name}`);
      }
      for (const p of collectSensitivePaths(payload)) {
        errors.push(`负载包含禁止的敏感字段（请改为断言+证据引用）：${p}`);
      }
    }
  }
  return errors;
}

export const DOMAIN_EVENT_TYPES = Object.freeze(eventTypes);
export const DOMAIN_AGGREGATE_TYPES = Object.freeze(aggregateTypes);
