// 面向三类角色的只读视图。全部从事件重放得到，不保存任何新的敏感数据。
//  - 游客：出发前知道每项体验的限制与确认状态；
//  - 供应商：只看到履约所必需的最小资料（无证件号）；
//  - 客服：从一次拒绝入场追溯到资格规则、设备公告、来源通知与退款责任。

import { IncidentView } from "./incidents.js";

const assertiveStateLabel = {
  REQUESTED: "待供应商确认",
  CONFIRMED: "已确认",
  REJECTED: "供应商已拒绝",
  TIMED_OUT: "供应商确认超时",
  CANCELLED: "已取消",
  CHECKED_IN: "已签到履约",
  ADMISSION_DENIED: "现场拒绝入场",
  INTERRUPTED: "服务中断，处置中",
  REPLACED: "已按同意的替换方案改约",
};

/** 游客出发前视图：逐项展示限制、确认状态、支付与退款、替换决定。 */
export function touristBundleView(app, bundleId) {
  const booking = app.bookings.view(bundleId);
  if (booking.status === "NEW") return null;
  const payment = app.payments.view(bundleId);
  const incidents = incidentsOfBundle(app.store, bundleId);

  const items = [...booking.items.values()].map((item) => {
    const product = app.catalog.get(item.product_id);
    const outage = app.equipment.activeOutage(product, { slot_id: item.slot_id });
    const itemIncidents = incidents.filter((inc) => inc.items.some((x) => x.item_id === item.item_id));
    const captured = payment.captures.filter((c) => c.item_id === item.item_id).reduce((s, c) => s + c.amount.amount, 0);
    const refunded = payment.refunds.filter((r) => r.item_id === item.item_id).reduce((s, r) => s + r.amount.amount, 0);
    return {
      item_id: item.item_id,
      product_id: product.product_id,
      title: product.title,
      slot: item.slot_id,
      confirmation_status: assertiveStateLabel[item.state] ?? item.state,
      restrictions: {
        real_name_required: product.eligibility_rules.some((r) => r.type === "real_name_required"),
        age: product.eligibility_rules
          .filter((r) => r.type === "min_age" || r.type === "max_age")
          .map((r) => (r.type === "min_age" ? `年满${r.min_age}周岁` : `不超过${r.max_age}周岁`)),
        adult_accompaniment: product.eligibility_rules
          .filter((r) => r.type === "adult_accompaniment_required")
          .map((r) => `${r.adult_required_under}周岁以下须成人陪同`),
        on_site_languages: product.languages,
        safety_notice: {
          version: product.safety_notice?.version ?? null,
          text: product.safety_notice?.text ?? null,
        },
        equipment: outage ? { status: "停运", reason: outage.reason_category } : { status: "正常" },
      },
      money: {
        price: item.price,
        captured: { amount: captured, currency: "CNY" },
        refunded: { amount: refunded, currency: "CNY" },
      },
      incidents: itemIncidents.map((inc) => ({
        incident_id: inc.incident_id,
        reason_category: inc.reason_category,
        status: inc.status,
        open_offer: latestOpenOffer(inc, item.item_id),
        decision: inc.decisions.find((d) => d.item_id === item.item_id)?.kind ?? null,
      })),
    };
  });

  return {
    bundle_id: bundleId,
    status: booking.status === "REQUESTED" ? "部分项目待确认" : booking.status === "CONFIRMED" ? "全部已确认" : "已取消",
    transport: booking.transport,
    items,
    payment: {
      authorized: payment.authorized,
      captured_total: { amount: payment.captures.reduce((s, c) => s + c.amount.amount, 0), currency: "CNY" },
      refunded_total: { amount: payment.refunds.reduce((s, r) => s + r.amount.amount, 0), currency: "CNY" },
    },
  };
}

/**
 * 供应商履约视图：只能看到本供应商、履约必需的最小资料。
 * 输入游客断言（由身份服务给出），只放行：核验是否通过、年龄段、可用语言、是否成人陪同。
 * 证件号码、出生日期、其他供应商的行程一律不出现。
 */
export function supplierFulfillmentView(app, { supplier_id, bundle_id }) {
  const booking = app.bookings.view(bundle_id);
  if (booking.status === "NEW") return null;
  const { deriveAssertionsSafe } = identityAssertions(app, booking.tourist_id);

  return [...booking.items.values()]
    .filter((item) => item.supplier_id === supplier_id)
    .map((item) => {
      const product = app.catalog.get(item.product_id);
      return {
        supplier_id,
        bundle_id,
        item_id: item.item_id,
        product_id: item.product_id,
        title: product.title,
        slot_id: item.slot_id,
        state: item.state,
        tourist_ref: booking.tourist_id,
        // 履约最小断言：不含任何证件号码/出生日期。
        tourist_requirements: {
          real_name_verified: deriveAssertionsSafe("real_name_verified"),
          age_years_at_experience: deriveAssertionsSafe("age_years_at"),
          accompanied_by_adult: deriveAssertionsSafe("accompanied_by_adult"),
          usable_languages: product.languages,
          safety_notice_version_to_check: product.safety_notice?.version ?? null,
        },
        checkin: {
          methods_accepted: ["qrcode", "staff_pad", "offline_signed_sheet"],
          must_collect_evidence: true,
        },
      };
    });
}

/**
 * 客服追溯视图：以一次"拒绝入场"为入口，给出完整责任链：
 * 拒绝记录 → 命中的资格规则原文 → 设备公告/事故 → 相关来源通知 → 退款分配责任方。
 */
export function admissionTraceView(app, { bundle_id, item_id }) {
  const denied = app.store
    .eventsForAggregate("booking_item", `${bundle_id}/${item_id}`)
    .find((e) => e.event_type === "ADMISSION_DENIED");
  if (!denied) return null;

  const product = app.catalog.get(denied.payload.product_id ?? findProductId(app, bundle_id, item_id));
  const booking = app.bookings.view(bundle_id);
  const item = booking.items.get(item_id);
  const payment = app.payments.view(bundle_id);

  // 1) 资格规则原文（若拒绝命中具体规则）。
  const matchedRule = denied.payload.rule_id ? product.eligibility_rules.find((r) => r.rule_id === denied.payload.rule_id) : null;

  // 2) 事故与设备公告。
  const incidents = incidentsOfBundle(app.store, bundle_id).filter((inc) => inc.items.some((x) => x.item_id === item_id));
  const equipmentAnnouncements = app.store
    .all()
    .filter(
      (e) =>
        e.event_type === "EQUIPMENT_STATUS_ANNOUNCED" &&
        (e.payload.scope.product_id === product.product_id) &&
        (!e.payload.scope.slot_id || e.payload.scope.slot_id === item_id)
    )
    .map((e) => ({
      status: e.payload.status,
      reason_category: e.payload.reason_category,
      effective_from: e.payload.effective_from,
      source_notification: e.source?.notification_id ?? null,
      event_id: e.event_id,
    }));

  // 3) 相关来源通知（去重/过期判定全部可见）。
  const notifications = app.store
    .all()
    .filter((e) => e.event_type === "NOTIFICATION_RECORDED")
    .filter((e) => {
      const p = e.payload;
      return (
        p.stream === `item:${bundle_id}/${item_id}` ||
        p.stream.startsWith(`equipment:${product.product_id}`) ||
        p.stream === `inventory:${product.product_id}/${item.slot_id}`
      );
    })
    .map((e) => ({
      notification_id: e.payload.notification_id,
      supplier_id: e.payload.supplier_id,
      stream: e.payload.stream,
      source_version: e.payload.source_version,
      kind: e.payload.kind,
      disposition: e.payload.disposition,
      occurred_at: e.payload.occurred_at,
      recorded_at: e.occurred_at,
      gap_from: e.payload.gap_from,
    }));

  // 4) 退款责任。
  const refunds = payment.refunds
    .filter((r) => r.item_id === item_id)
    .map((r) => ({ refund_id: r.refund_id, amount: r.amount, responsible_party: r.responsible_party, basis: r.basis, status: r.status }));

  return {
    admission: {
      bundle_id,
      item_id,
      reason_code: denied.payload.reason_code,
      reason_detail: denied.payload.reason_detail,
      recorded_at: denied.payload.recorded_at,
      rule_id: denied.payload.rule_id ?? null,
      evidence_ref: denied.payload.evidence_ref ?? null,
    },
    eligibility_rule: matchedRule
      ? {
          rule_id: matchedRule.rule_id,
          type: matchedRule.type,
          detail: matchedRule,
          product_safety_notice_version: product.safety_notice?.version ?? null,
        }
      : null,
    incidents: incidents.map((inc) => ({
      incident_id: inc.incident_id,
      reason_category: inc.reason_category,
      severity: inc.severity,
      status: inc.status,
      escalation_chain: inc.escalations.map((x) => ({ level: x.level, to_role: x.to_role, at: x.at, due_at: x.due_at })),
      replacement_offers: inc.offers.filter((o) => o.item_id === item_id).map((o) => ({ quote_version: o.quote_version, expires_at: o.expires_at, quote: o.quote })),
      decisions: inc.decisions.filter((d) => d.item_id === item_id).map((d) => ({ kind: d.kind, quote_version: d.quote_version, consent: d.consent ?? null })),
    })),
    equipment_announcements: equipmentAnnouncements,
    source_notifications: notifications,
    refunds,
  };
}

// —— 内部辅助 ——

function identityAssertions(app, touristId) {
  // 延迟引入避免循环依赖。
  const events = app.store.eventsForAggregate("eligibility_assertion", touristId);
  const latest = events.at(-1)?.payload.assertions ?? [];
  return {
    deriveAssertionsSafe(key) {
      return latest.find((a) => a.key === key)?.value ?? null;
    },
  };
}

function incidentsOfBundle(store, bundleId) {
  const ids = new Set();
  for (const e of store.all()) {
    if (e.aggregate_type === "service_incident" && e.event_type === "SERVICE_INTERRUPTED") {
      if (e.payload.items.some((x) => x.bundle_id === bundleId)) ids.add(e.aggregate_id);
    }
  }
  return [...ids].map((id) => IncidentView.build(store, id));
}

function latestOpenOffer(inc, itemId) {
  const offers = inc.offers.filter((o) => o.item_id === itemId);
  const latest = offers.at(-1);
  if (!latest) return null;
  const decided = inc.decisions.some((d) => d.item_id === itemId && d.quote_version === latest.quote_version);
  return decided ? null : { quote_version: latest.quote_version, expires_at: latest.expires_at, quote: latest.quote };
}

function findProductId(app, bundleId, itemId) {
  const requested = app.store
    .all()
    .find((e) => e.aggregate_type === "booking_item" && e.event_type === "ITEM_REQUESTED" && e.payload.item_id === itemId && e.payload.bundle_id === bundleId);
  return requested?.payload?.product_id;
}
