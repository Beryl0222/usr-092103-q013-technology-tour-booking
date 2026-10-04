// 生成 data/flow.sample.json：一条从发起到停运替换的完整事件轨迹，供跨团队联调对照。
// 用法：node scripts/build-flow-sample.mjs
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { seedApp } from "../src/seed.js";
import { setClock, resetCounter } from "../src/runtime.js";
import { touristBundleView } from "../src/views.js";

const run = async () => {
  resetCounter();
  setClock(() => "2026-10-09T12:00:00+08:00");
  const app = createApp();
  await seedApp(app);

  // 林先生预约上午的无人车（已完成实名、18 岁、中英双语）。
  const { bundleId } = app.bookings.requestBundle({
    tourist_id: "tourist-lin",
    lines: [{ item_id: "line-auto", product_id: "auto-shuttle", slot_id: "AM-0900" }],
  });
  app.bookings.supplierRespond({
    bundle_id: bundleId,
    item_id: "line-auto",
    supplier_id: "SUP-AUTO",
    notification_id: "AUTO-CONFIRM-77",
    source_version: 1,
    occurred_at: "2026-10-09T12:03:00+08:00",
    kind: "confirm",
  });

  // 出发当天无人车临时停运（供应商公告 v3，此前 v1/v2 为更早状态）。
  app.equipmentNotice({
    supplier_id: "SUP-AUTO",
    notification_id: "AUTO-EQ-20261010-03",
    source_version: 3,
    occurred_at: "2026-10-10T08:20:00+08:00",
    scope: { product_id: "auto-shuttle", slot_id: "AM-0900" },
    status: "OUTAGE",
    reason_category: "EQUIPMENT_FAULT",
    reason_detail: "激光雷达自检未通过，全线车辆回库",
    effective_from: "2026-10-10T08:20:00+08:00",
  });
  const incident = app.incidents.open({
    items: [{ bundle_id: bundleId, item_id: "line-auto" }],
    reason_category: "EQUIPMENT_OUTAGE",
    severity: "HIGH",
  });
  app.incidents.offerReplacement(incident.incident_id, {
    bundle_id: bundleId,
    item_id: "line-auto",
    at: "2026-10-10T08:25:00+08:00",
    ttl_minutes: 120,
    quote: { product_id: "drone-pickup", slot_id: "AM-1100", price: { amount: 8800, currency: "CNY" }, supplier_id: "SUP-DRONE" },
  });
  const offer = app.incidents.view(incident.incident_id).offers.at(-1);
  app.incidents.acceptReplacement(incident.incident_id, {
    bundle_id: bundleId,
    item_id: "line-auto",
    at: "2026-10-10T08:31:00+08:00",
    consent: { actor: "tourist-lin", channel: "app", acted_at: "2026-10-10T08:31:00+08:00", quote_version: offer.quote_version },
  });

  const flow = {
    scenario: "无人车临时停运，平台开事故并取得游客对替换报价的重新同意",
    generated_for: "2026-10-10 科技体验日",
    event_count: app.store.all().length,
    events: app.store.all().map((e) => ({
      event_type: e.event_type,
      aggregate_type: e.aggregate_type,
      aggregate_id: e.aggregate_id,
      version: e.version,
      summary: e.summary,
      source_notification: e.source?.notification_id ?? null,
      payload_keys: Object.keys(e.payload ?? {}),
    })),
    tourist_view: touristBundleView(app, bundleId),
  };

  const out = new URL("../data/flow.sample.json", import.meta.url);
  await writeFile(fileURLToPath(out), `${JSON.stringify(flow, null, 2)}\n`, "utf8");
  console.log(`已写出 ${flow.event_count} 个事件到 data/flow.sample.json`);
};

run();
