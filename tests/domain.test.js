import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createApp } from "../src/app.js";
import { seedApp } from "../src/seed.js";
import { setClock, resetCounter } from "../src/runtime.js";
import { validateEvent } from "../src/validator.js";
import { deriveAssertions } from "../src/identity.js";
import { DomainError } from "../src/errors.js";
import { touristBundleView, supplierFulfillmentView, admissionTraceView } from "../src/views.js";

// —— 公共搭建：装载目录与游客断言，时钟固定在体验当天早晨 ——
async function boot() {
  resetCounter();
  setClock(() => "2026-10-09T12:00:00+08:00");
  const app = createApp();
  await seedApp(app);
  return app;
}

const failCode = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

const catchError = (fn) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
  throw new Error("预期抛出 DomainError，但未抛出");
};

const SAFETY_ACKS = { "smart-factory": { notice_version: "SF-SAFE-5", acknowledged_at: "2026-10-09T12:00:00+08:00" } };

test("样例仍符合领域信封约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("所有入库事件都能通过公共校验器", async () => {
  const app = await boot();
  const { bundleId } = requestAutoShuttle(app);
  app.bookings.supplierRespond(confirmNotice(bundleId, "line-auto", "SUP-AUTO", "N-1", 1));
  for (const e of app.store.all()) assert.deepEqual(validateEvent(e), [], `事件 ${e.event_id} 校验失败：${validateEvent(e).join(";")}`);
});

test("护照等原始信息只转换为最小断言，事件中绝不出现证件号字段", async () => {
  const app = await boot();
  const profile = {
    tourist_id: "t-secret",
    real_name_verified: true,
    document_kind: "passport",
    passport_number: "E12345678",
    date_of_birth: "2000-01-01",
    document_expiry_date: "2030-01-01",
    evidence_ref: "vault://x",
  };
  const assertions = deriveAssertions(profile, { at: "2026-10-10T08:00:00+08:00" });
  const serialized = JSON.stringify(assertions);
  assert.ok(!serialized.includes("E12345678"));
  assert.equal(assertions.find((a) => a.key === "age_years_at").value, 26);

  // 校验器直接拒绝携带敏感字段的事件。
  const bad = {
    event_id: "x",
    event_type: "ELIGIBILITY_ASSERTED",
    aggregate_type: "eligibility_assertion",
    aggregate_id: "t-secret",
    occurred_at: "2026-10-10T08:00:00+08:00",
    version: 1,
    summary: "坏事件",
    payload: { tourist_id: "t-secret", passport_number: "E12345678", assertions: [] },
  };
  assert.ok(validateEvent(bad).some((m) => m.includes("敏感字段")));
});

test("确认前预检：年龄不足、语言不支持、安全告知未确认、库存为零分别被拦截", async () => {
  const app = await boot();

  // tourist-kid 2016 年生，体验当天 10 岁：无人车要求 14 岁
  assert.equal(
    failCode(() =>
      app.bookings.requestBundle({
        tourist_id: "tourist-kid",
        lines: [{ item_id: "l1", product_id: "auto-shuttle", slot_id: "AM-0900" }],
      })
    ),
    "ELIGIBILITY_NOT_MET"
  );

  // tourist-tanaka 仅日语：智能工厂只支持中文现场服务 → 语言不足（且证件过期、未确认安全告知）
  const err = catchError(
    () =>
      app.bookings.requestBundle({
        tourist_id: "tourist-tanaka",
        lines: [{ item_id: "l1", product_id: "smart-factory", slot_id: "AM-1000" }],
        safety_acks: {},
      })
  );
  const ruleKinds = err.details.problems.flatMap((p) => (p.failures ?? []).map((f) => f.reason_code));
  assert.ok(ruleKinds.includes("DOCUMENT_EXPIRED"));
  assert.ok(ruleKinds.includes("SAFETY_NOTICE_NOT_ACKNOWLEDGED"));
  assert.ok(ruleKinds.includes("LANGUAGE_UNSUPPORTED"));

  // 机器人门店余位 0 → 库存拦截
  assert.equal(
    failCode(() =>
      app.bookings.requestBundle({
        tourist_id: "tourist-lin",
        lines: [{ item_id: "l1", product_id: "robot-store", slot_id: "PM-1600" }],
      })
    ),
    "ELIGIBILITY_NOT_MET"
  );
});

test("组合行程交通缓冲不足时拒绝确认", async () => {
  const app = await boot();
  const err = catchError(() =>
    app.bookings.requestBundle({
      tourist_id: "tourist-lin",
      lines: [
        { item_id: "l1", product_id: "auto-shuttle", slot_id: "AM-0900" }, // 10:00 结束
        { item_id: "l2", product_id: "drone-pickup", slot_id: "AM-1100" }, // 11:00 开始
      ],
      transport: { default_buffer_minutes: 90 }, // 实际只有 60 分钟
      safety_acks: SAFETY_ACKS,
    })
  );
  assert.ok(err.details.problems.some((p) => p.kind === "transport"));
});

test("设备停运公告使该时段不可预订；迟到的旧版本公告不能复活设备", async () => {
  const app = await boot();
  // v2 停运
  app.equipmentNotice(outageNotice("SUP-AUTO", "EQ-2", 2, "2026-10-09T08:00:00+08:00", { product_id: "auto-shuttle", slot_id: "AM-0900" }));
  // v1 更晚到达（旧版本）→ STALE，不能覆盖
  const stale = app.equipmentNotice(outageNotice("SUP-AUTO", "EQ-1", 1, "2026-10-09T07:00:00+08:00", { product_id: "auto-shuttle", slot_id: "AM-0900" }, "OPERATIONAL"));
  assert.equal(stale.disposition, "STALE");

  assert.equal(
    failCode(() =>
      app.bookings.requestBundle({
        tourist_id: "tourist-lin",
        lines: [{ item_id: "l1", product_id: "auto-shuttle", slot_id: "AM-0900" }],
      })
    ),
    "ELIGIBILITY_NOT_MET"
  );
});

test("全部供应商确认后行程才确认，且只授权一次；重复回调与超时后迟到确认都无效", async () => {
  const app = await boot();
  const { bundleId } = requestDroneAndFactory(app);

  app.bookings.supplierRespond(confirmNotice(bundleId, "line-drone", "SUP-DRONE", "D-1", 1));
  assert.equal(app.bookings.view(bundleId).status, "REQUESTED", "还有供应商未确认，行程不能确认");
  assert.equal(app.payments.view(bundleId).authorized, null, "未全部确认前不得授权");

  // 同一回调重放 → DUPLICATE，无副作用
  const dup = app.bookings.supplierRespond(confirmNotice(bundleId, "line-drone", "SUP-DRONE", "D-1", 1));
  assert.equal(dup.disposition, "DUPLICATE");

  app.bookings.supplierRespond(confirmNotice(bundleId, "line-factory", "SUP-FACTORY", "F-1", 1));
  assert.equal(app.bookings.view(bundleId).status, "CONFIRMED");
  const pay = app.payments.view(bundleId);
  assert.equal(pay.authorized.amount, 8800 + 15000);

  // 重复授权调度必须幂等
  app.payments.authorize(bundleId, pay.authorized, `auth:${bundleId}`);
  assert.equal(app.payments.view(bundleId).version, pay.version);
});

test("供应商超时触发整单取消，之后迟到的确认不能改状态也不扣款", async () => {
  const app = await boot();
  const { bundleId } = requestDroneAndFactory(app);
  app.bookings.supplierRespond(confirmNotice(bundleId, "line-drone", "SUP-DRONE", "D-9", 1));
  app.bookings.supplierTimeout(bundleId, "line-factory");
  assert.equal(app.bookings.view(bundleId).status, "CANCELLED");
  assert.equal(app.payments.view(bundleId).authorized, null);

  // 迟到确认：通知留痕（APPLIED 于通知流），但业务跃迁被拒
  assert.throws(
    () => app.bookings.supplierRespond(confirmNotice(bundleId, "line-factory", "SUP-FACTORY", "F-LATE", 1, "2026-10-09T13:00:00+08:00")),
    (e) => e.code === "ILLEGAL_ITEM_STATE"
  );
});

test("供应商拒绝导致整单取消并连带取消其他在途行", async () => {
  const app = await boot();
  const { bundleId } = requestDroneAndFactory(app);
  app.bookings.supplierRespond({
    bundle_id: bundleId,
    item_id: "line-factory",
    supplier_id: "SUP-FACTORY",
    notification_id: "F-REJ",
    source_version: 1,
    occurred_at: "2026-10-09T12:05:00+08:00",
    kind: "reject",
    reason: "当日安全演练不开放",
  });
  const view = app.bookings.view(bundleId);
  assert.equal(view.status, "CANCELLED");
  assert.equal(view.items.get("line-drone").state, "CANCELLED");
  assert.equal(app.payments.view(bundleId).authorized, null);
});

test("离线签到重传只签到一次、只请款一次", async () => {
  const app = await boot();
  const { bundleId } = requestAutoShuttle(app);
  app.bookings.supplierRespond(confirmNotice(bundleId, "line-auto", "SUP-AUTO", "A-1", 1));

  const checkin = {
    bundle_id: bundleId,
    item_id: "line-auto",
    tourist_id: "tourist-lin",
    method: "offline_signed_sheet",
    evidence_ref: "vault://checkin/line-auto-sheet-7",
    recorded_at: "2026-10-10T09:05:00+08:00",
    offline: true,
  };
  const first = app.bookings.recordCheckin(checkin);
  assert.equal(first.duplicate, false);
  const replay = app.bookings.recordCheckin({ ...checkin });
  assert.equal(replay.duplicate, true);

  // 供应商支付回调重复（相同幂等键）也不能二次请款
  app.payments.capture(bundleId, "line-auto", { amount: 12000, currency: "CNY" }, `capture:${bundleId}:line-auto`);
  const captures = app.payments.view(bundleId).captures;
  assert.equal(captures.length, 1);
  assert.equal(captures[0].amount.amount, 12000);
});

test("现场拒绝入场可追到资格规则、通知与退款责任（部分履约按合同 50% 退）", async () => {
  const app = await boot();
  const { bundleId } = requestAutoShuttle(app);
  app.bookings.supplierRespond(confirmNotice(bundleId, "line-auto", "SUP-AUTO", "A-1", 1));
  app.bookings.recordCheckin({
    bundle_id: bundleId,
    item_id: "line-auto",
    tourist_id: "tourist-lin",
    method: "staff_pad",
    evidence_ref: "vault://checkin/line-auto-1",
    recorded_at: "2026-10-10T09:00:00+08:00",
  });
  // 现场以安全告知未达标拒绝（示例 rule_id 走安全规则）
  app.bookings.recordAdmissionDenied({
    bundle_id: bundleId,
    item_id: "line-auto",
    tourist_id: "tourist-lin",
    reason_code: "SAFETY_GEAR_REFUSED",
    reason_detail: "游客拒绝穿戴防护设备",
    rule_id: "AS-LANG", // 串一条可展示的规则原文用于追溯断言
    evidence_ref: "vault://deny/line-auto-clip",
  });

  const incident = app.incidents.open({
    items: [{ bundle_id: bundleId, item_id: "line-auto" }],
    reason_category: "ADMISSION_DENIED",
    severity: "MEDIUM",
  });
  app.incidents.resolveWithRefund(incident.incident_id, {
    bundle_id: bundleId,
    item_id: "line-auto",
    clause_key: "partial_performance",
  });

  const trace = admissionTraceView(app, { bundle_id: bundleId, item_id: "line-auto" });
  assert.equal(trace.admission.reason_code, "SAFETY_GEAR_REFUSED");
  assert.equal(trace.eligibility_rule.rule_id, "AS-LANG"); // 规则原文可追溯
  assert.equal(trace.refunds[0].amount.amount, 6000); // 12000 × 50%
  assert.equal(trace.refunds[0].responsible_party, "SUP-AUTO"); // 责任方明确，不推诿
  assert.ok(trace.source_notifications.some((n) => n.notification_id === "A-1"));
});

test("停运替换：必须按当前报价版本重新取得游客明确同意，过期或错版本一律拒绝", async () => {
  const app = await boot();
  const { bundleId } = requestAutoShuttle(app);
  app.bookings.supplierRespond(confirmNotice(bundleId, "line-auto", "SUP-AUTO", "A-1", 1));

  // 供应商发布停运，平台开事故
  app.equipmentNotice(outageNotice("SUP-AUTO", "EQ-DOWN", 1, "2026-10-10T08:30:00+08:00", { product_id: "auto-shuttle", slot_id: "AM-0900" }));
  const incident = app.incidents.open({
    items: [{ bundle_id: bundleId, item_id: "line-auto" }],
    reason_category: "EQUIPMENT_OUTAGE",
    severity: "HIGH",
  });

  // 升级链：L1 立即派发
  assert.equal(incident.escalations[0].level, "L1_SUPPLIER");
  // SLA 超时自动升到 L2
  const escalated = app.incidents.autoEscalateDue("2026-10-10T09:05:00+08:00");
  assert.ok(escalated.includes(incident.incident_id));

  app.incidents.offerReplacement(incident.incident_id, {
    bundle_id: bundleId,
    item_id: "line-auto",
    quote: { product_id: "drone-pickup", slot_id: "AM-1100", price: { amount: 8800, currency: "CNY" }, supplier_id: "SUP-DRONE" },
    ttl_minutes: 60,
    at: "2026-10-10T08:35:00+08:00",
  });
  const offer = app.incidents.view(incident.incident_id).offers.at(-1);

  // 错误报价版本的同意被拒
  assert.equal(
    failCode(() =>
      app.incidents.acceptReplacement(incident.incident_id, {
        bundle_id: bundleId,
        item_id: "line-auto",
        consent: { actor: "tourist-lin", channel: "app", acted_at: "2026-10-10T08:40:00+08:00", quote_version: "WRONG" },
      })
    ),
    "QUOTE_VERSION_MISMATCH"
  );
  // 过期同意被拒
  assert.equal(
    failCode(() =>
      app.incidents.acceptReplacement(incident.incident_id, {
        bundle_id: bundleId,
        item_id: "line-auto",
        at: "2026-10-10T11:00:00+08:00",
        consent: { actor: "tourist-lin", channel: "app", acted_at: "2026-10-10T11:00:00+08:00", quote_version: offer.quote_version },
      })
    ),
    "CONSENT_REQUIRED"
  );

  // 正确版本 + 有效期内的明确同意才生效；未请款，退款记录为授权释放 0 元，责任仍记供应商
  app.incidents.acceptReplacement(incident.incident_id, {
    bundle_id: bundleId,
    item_id: "line-auto",
    at: "2026-10-10T08:45:00+08:00",
    consent: { actor: "tourist-lin", channel: "app", acted_at: "2026-10-10T08:45:00+08:00", quote_version: offer.quote_version },
  });
  const item = app.bookings.view(bundleId).items.get("line-auto");
  assert.equal(item.state, "REPLACED");
  const refund = app.payments.view(bundleId).refunds.at(-1);
  assert.equal(refund.amount.amount, 0);
  assert.equal(refund.status, "AUTH_RELEASED_NO_CAPTURE");
  assert.equal(refund.responsible_party, "SUP-AUTO");
});

test("游客拒绝替换：已请款部分按合同全额退还该停运行", async () => {
  const app = await boot();
  const { bundleId } = requestAutoShuttle(app);
  app.bookings.supplierRespond(confirmNotice(bundleId, "line-auto", "SUP-AUTO", "A-1", 1));
  app.bookings.recordCheckin({
    bundle_id: bundleId,
    item_id: "line-auto",
    tourist_id: "tourist-lin",
    method: "qrcode",
    evidence_ref: "vault://checkin/line-auto-q",
  });
  // 履约途中停运
  app.equipmentNotice(outageNotice("SUP-AUTO", "EQ-MID", 1, "2026-10-10T09:30:00+08:00", { product_id: "auto-shuttle", slot_id: "AM-0900" }));
  const incident = app.incidents.open({
    items: [{ bundle_id: bundleId, item_id: "line-auto" }],
    reason_category: "EQUIPMENT_OUTAGE",
  });
  app.incidents.offerReplacement(incident.incident_id, {
    bundle_id: bundleId,
    item_id: "line-auto",
    quote: { product_id: "drone-pickup", slot_id: "AM-1100", price: { amount: 8800, currency: "CNY" }, supplier_id: "SUP-DRONE" },
  });
  app.incidents.declineReplacement(incident.incident_id, {
    bundle_id: bundleId,
    item_id: "line-auto",
    reason: "时间冲突，不接受改约",
  });
  const refunds = app.payments.view(bundleId).refunds;
  // 取消条款 ratio=1，已请款 12000 全额退
  assert.equal(refunds.at(-1).amount.amount, 12000);
  assert.equal(app.bookings.view(bundleId).items.get("line-auto").state, "CANCELLED");
  assert.equal(app.incidents.view(incident.incident_id).status, "RESOLVED");
});

test("游客视图展示每项限制与确认状态；供应商视图只给履约最小资料", async () => {
  const app = await boot();
  const { bundleId } = requestDroneAndFactory(app);
  app.bookings.supplierRespond(confirmNotice(bundleId, "line-drone", "SUP-DRONE", "D-1", 1));
  app.bookings.supplierRespond(confirmNotice(bundleId, "line-factory", "SUP-FACTORY", "F-1", 1));

  const tv = touristBundleView(app, bundleId);
  const factory = tv.items.find((i) => i.product_id === "smart-factory");
  assert.deepEqual(factory.restrictions.age, ["年满16周岁"]);
  assert.deepEqual(factory.restrictions.on_site_languages, ["zh"]);
  assert.equal(factory.confirmation_status, "已确认");

  // 供应商只看到自己的行，且看不到任何证件号/出生日期
  const sv = supplierFulfillmentView(app, { supplier_id: "SUP-FACTORY", bundle_id: bundleId });
  assert.equal(sv.length, 1);
  assert.equal(sv[0].tourist_requirements.age_years_at_experience, 18);
  const blob = JSON.stringify(sv);
  assert.ok(!blob.includes("passport"));
  assert.ok(!blob.includes("date_of_birth"));
  assert.ok(!blob.includes("2008-05-01"));
  // 无人机供应商看不到工厂行
  assert.equal(supplierFulfillmentView(app, { supplier_id: "SUP-DRONE", bundle_id: bundleId })[0].product_id, "drone-pickup");
});

test("event_id 全局幂等：同一事件重复提交不产生第二条", async () => {
  const app = await boot();
  const before = app.store.all().length;
  const evt = app.store.all().find((e) => e.event_type === "EXPERIENCE_PUBLISHED");
  app.store.append(evt);
  assert.equal(app.store.all().length, before);
});

// —— 辅助 ——
function requestAutoShuttle(app) {
  const res = app.bookings.requestBundle({
    tourist_id: "tourist-lin",
    lines: [{ item_id: "line-auto", product_id: "auto-shuttle", slot_id: "AM-0900" }],
  });
  return { bundleId: res.bundleId };
}

function requestDroneAndFactory(app) {
  const res = app.bookings.requestBundle({
    tourist_id: "tourist-lin",
    lines: [
      { item_id: "line-drone", product_id: "drone-pickup", slot_id: "PM-1230" },
      { item_id: "line-factory", product_id: "smart-factory", slot_id: "AM-1000" },
    ],
    transport: { default_buffer_minutes: 30 },
    safety_acks: SAFETY_ACKS,
  });
  return { bundleId: res.bundleId };
}

function confirmNotice(bundleId, itemId, supplierId, notificationId, sourceVersion, occurredAt = "2026-10-09T12:05:00+08:00") {
  return { bundle_id: bundleId, item_id: itemId, supplier_id: supplierId, notification_id: notificationId, source_version: sourceVersion, occurred_at: occurredAt, kind: "confirm" };
}

function outageNotice(supplierId, notificationId, version, occurredAt, scope, status = "OUTAGE") {
  return {
    supplier_id: supplierId,
    notification_id: notificationId,
    source_version: version,
    occurred_at: occurredAt,
    scope,
    status,
    reason_category: "EQUIPMENT_FAULT",
    reason_detail: "传感器自检未通过",
    effective_from: occurredAt,
  };
}
