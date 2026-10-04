// 从 data/catalog.seed.json 装载目录与游客断言。原始档案不落事件流。
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deriveAssertions, recordAssertions } from "./identity.js";

export async function seedApp(app, seedUrl = new URL("../data/catalog.seed.json", import.meta.url)) {
  const seed = JSON.parse(await readFile(fileURLToPath(seedUrl), "utf8"));
  for (const product of seed.products) app.publishProduct(product);

  const profiles = {};
  for (const profile of Object.values(seed.profiles)) {
    // 仅在入口短暂持有原始档案，转换为最小断言后丢弃。
    const assertions = deriveAssertions(profile, { at: "2026-10-10T08:00:00+08:00" });
    recordAssertions(app.store, profile.tourist_id, assertions);
    profiles[profile.tourist_id] = true;
  }
  return { productIds: seed.products.map((p) => p.product_id), touristIds: Object.keys(profiles) };
}
