// 应用装配：事件存储 + 各领域服务 + 实时投影。零依赖、可在测试中整体替换时钟。
import { EventStore } from "./event-store.js";
import { NotificationGateway } from "./notification-gateway.js";
import { CatalogView, publishProduct, recordInventory } from "./catalog.js";
import { EquipmentView, announceEquipmentStatus } from "./equipment.js";
import { PaymentService } from "./payments.js";
import { BookingService } from "./bookings.js";
import { IncidentService } from "./incidents.js";
import { latestAssertions } from "./identity.js";

export function createApp() {
  const store = new EventStore();

  // 实时读模型：订阅存储，随事件持续更新。
  const catalog = new CatalogView();
  const equipment = new EquipmentView();
  store.subscribe((e) => {
    catalog.apply(e);
    equipment.apply(e);
  });

  const gateway = new NotificationGateway(store);
  const payments = new PaymentService(store);
  const bookings = new BookingService({
    store,
    catalog,
    equipment,
    payments,
    gateway,
    assertionsOf: (touristId) => latestAssertions(store, touristId),
  });
  const incidents = new IncidentService({ store, catalog, payments });

  return {
    store,
    catalog,
    equipment,
    gateway,
    payments,
    bookings,
    incidents,

    // —— 目录与运营入口 ——
    publishProduct: (product) => publishProduct(store, product),

    /** 供应商库存通知（经网关版本把关后落库）。 */
    inventoryNotice: (notice) =>
      gateway.ingest(
        {
          supplier_id: notice.supplier_id,
          notification_id: notice.notification_id,
          source_version: notice.source_version,
          occurred_at: notice.occurred_at,
          stream: `inventory:${notice.product_id}/${notice.slot_id}`,
          kind: "inventory",
          data: notice,
        },
        (d) =>
          recordInventory(store, d.product_id, d.slot_id, d.available_seats, {
            system: d.supplier_id,
            notification_id: d.notification_id,
            source_version: d.source_version,
          })
      ),

    /** 设备状态公告通知（旧版本迟到不能复活停运设备）。 */
    equipmentNotice: (notice) =>
      gateway.ingest(
        {
          supplier_id: notice.supplier_id,
          notification_id: notice.notification_id,
          source_version: notice.source_version,
          occurred_at: notice.occurred_at,
          stream: `equipment:${notice.scope.slot_id ? `${notice.scope.product_id}/${notice.scope.slot_id}` : notice.scope.product_id}`,
          kind: "equipment",
          data: notice,
        },
        (d) =>
          announceEquipmentStatus(store, {
            scope: d.scope,
            status: d.status,
            reason_category: d.reason_category,
            reason_detail: d.reason_detail,
            effective_from: d.effective_from,
            effective_to: d.effective_to ?? null,
            source: { system: d.supplier_id, notification_id: d.notification_id, source_version: d.source_version },
          })
      ),
  };
}
