// 可在测试中替换时钟与序号的运行时小工具。
let counter = 0;
let clock = () => new Date().toISOString();

export const now = () => clock();
export const setClock = (fn) => {
  clock = fn;
};

export const newId = (prefix) => {
  counter += 1;
  const t = Date.now().toString(36);
  return `${prefix}_${t}_${counter.toString(36)}`;
};

export const resetCounter = () => {
  counter = 0;
};

/** 两个时段之间的交通缓冲是否达标：到达下一项必须至少留出 bufferMinutes。 */
export function bufferMinutesBetween(prevEndIso, nextStartIso) {
  return (Date.parse(nextStartIso) - Date.parse(prevEndIso)) / 60000;
}
