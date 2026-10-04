# 科技体验预约保障

旅行社把**无人车、无人机取餐、机器人门店、智能工厂**排进同一天后，游客常因实名要求、年龄限制、设备停运或语言支持不足在现场被拒，退款又被四个供应商相互推诿。本仓库是「体验预约保障后端」的领域实现：统一描述项目时段、资格条件、安全告知、语言能力、设备状态、供应商库存、支付授权、签到证据与事故升级，同时**保留各供应商自己的确认权**。

零第三方依赖，Node 原生 ESM + `node:test`，事件溯源（Event Sourcing）实现。

## 它如何解决题述问题

| 现场痛点 | 保障机制 |
| --- | --- |
| 四个供应商口径不一、相互推诿 | 统一事件信封与目录；每一行退款都带**合同条款 + 责任方**，谁的责任一目了然 |
| 游客出发前不知道限制与确认状态 | `touristBundleView`：逐项展示实名/年龄/陪同/语言/安全告知/设备状态与确认状态 |
| 护照等敏感信息泄露风险 | 原始证件**绝不进入事件流**，入口只转换为最小断言（是否实名、年龄段、语言、陪同）；校验器直接拒绝证件号字段 |
| 供应商通知乱序、重复、旧状态覆盖新状态 | 通知网关按 `(source_version, occurred_at)` 定序：`APPLIED / DUPLICATE / STALE`，全部留痕 |
| 组合行程时间冲突 | 确认前校验相邻项目**交通缓冲**（支持按段定制），不足即拒绝 |
| 供应商确认权 | 每行独立的确认/拒绝回调；**全部确认后**整单才确认并一次性授权冻结；任一行失败整单取消、不扣款 |
| 重复回调 / 离线签到 / 超时迟到确认导致重复扣款 | 事件 `event_id` 幂等、通知去重、签到固定幂等键、支付授权/请款/退款全部幂等；迟到确认在超时后状态机拒绝 |
| 无人车/工厂临时停运 | 设备公告驱动事故单，三级升级与 SLA 超时自动升级 |
| 擅自替换项目 | 替换方案是**不可变报价**（`quote_version` + 过期时间），游客必须按当前版本在有效期内重新明确同意 |
| 部分履约退款 | 按原项目合同条款逐行计算（全退/半退/不退），未请款行登记「授权自动释放」并仍记录责任方 |
| 客服无法定责 | `admissionTraceView`：一次拒绝入场 → 资格规则原文 → 设备公告 → 来源通知（含去重/过期判定）→ 退款责任 |

## 资料结构

```
contracts/domain.schema.json   统一事件信封、稳定枚举、来源(source)与幂等语义
data/sample.json               最小业务事件样例（兼容最初约定）
data/catalog.seed.json         四个体验项目的目录种子 + 三个游客原始档案（仅装载时短暂出现）
data/flow.sample.json          完整联调轨迹（停运→事故→替换重获同意→退款），由脚本生成
src/
  validator.js                 信封枚举/时间/负载必备字段 + 敏感字段拦截
  errors.js                    稳定错误码（DomainError.code）
  event-store.js               仅追加事件存储：event_id 幂等 + 聚合版本乐观并发
  notification-gateway.js      外部通知入口：版本/发生时间定序、去重、过期隔离
  catalog.js                   产品发布（报价版本）、库存、目录读模型
  equipment.js                 设备状态公告（产品级/时段级）与停运判定
  identity.js                  证件资料 → 最小断言；ELIGIBILITY_ASSERTED
  eligibility.js               资格规则评估 + 组合交通缓冲校验
  bookings.js                  组合行程生命周期、供应商确认权、（离线）签到、拒绝入场
  payments.js                  授权一次、按行请款、按行退款，全幂等
  refunds.js                   按合同条款计算部分履约退款
  incidents.js                 事故开单、SLA 分级升级、替换报价与重获同意
  views.js                     游客视图 / 供应商履约最小资料视图 / 客服追溯视图
  app.js / seed.js / runtime.js 装配、种子装载、可替换时钟
scripts/build-flow-sample.mjs  重新生成 data/flow.sample.json
tests/                         16 个端到端场景测试
```

## 事件与状态机

核心事件（完整清单见 `contracts/domain.schema.json`）：

`EXPERIENCE_PUBLISHED` · `INVENTORY_UPDATED` · `EQUIPMENT_STATUS_ANNOUNCED` · `NOTIFICATION_RECORDED`
· `ELIGIBILITY_ASSERTED` · `BUNDLE_REQUESTED` · `ITEM_REQUESTED`
· `SUPPLIER_CONFIRMED/REJECTED/TIMEOUT` · `ITEM_CANCELLED/INTERRUPTED/REPLACED`
· `BUNDLE_CONFIRMED/CANCELLED` · `PAYMENT_AUTHORIZED/CAPTURED` · `REFUND_ALLOCATED`
· `CHECKIN_RECORDED` · `ADMISSION_DENIED`
· `SERVICE_INTERRUPTED` · `INCIDENT_ESCALATED/RESOLVED`
· `REPLACEMENT_OFFERED/ACCEPTED/DECLINED`

行程行状态机：

```
REQUESTED ──供应商确认──▶ CONFIRMED ──签到──▶ CHECKED_IN ──现场拒绝──▶ ADMISSION_DENIED
     ├────供应商拒绝────▶ REJECTED
     ├────平台 SLA 超时─▶ TIMED_OUT      （迟到确认在此被状态机拒绝，通知仍留痕）
     └────同行失败连带─▶ CANCELLED
CONFIRMED/CHECKED_IN ──停运──▶ INTERRUPTED ──游客同意替换──▶ REPLACED
                                          └─游客拒绝/不替换─▶ CANCELLED（按合同退款）
```

支付只在 `BUNDLE_CONFIRMED` 后授权一次；请款只发生在签到后；退款按合同条款逐行分配，
同一行累计退款不得超过该行已请款金额。

## 三类角色视图

- **游客**（`touristBundleView`）：出发前看到每一项的实名、年龄、成人陪同、现场语言、安全告知版本、设备状态，以及逐项确认状态与钱的去向。
- **供应商**（`supplierFulfillmentView`）：只能看到**本供应商**自己的行，资料仅限履约最小断言（是否实名、年龄段、是否成人陪同、需核验的安全告知版本）；证件号、出生日期、其他供应商行程一律不出现。
- **客服**（`admissionTraceView`）：以一次拒绝入场为入口，串联规则原文、设备公告、全部相关通知（含 `DUPLICATE/STALE` 判定与版本缺口）、事故升级链、替换报价/同意、退款责任方。

## 本地检查

```bash
npm test                 # 运行 16 个场景测试
node scripts/build-flow-sample.mjs   # 重新生成联调样例
```
