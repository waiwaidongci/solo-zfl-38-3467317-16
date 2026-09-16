// 写接口的严格 JSON 类型校验工具：
// 只认 JSON 原生类型，禁止布尔→数字、数组→字符串之类的隐式转换。

export function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
export function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}
export function isPositiveNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}
export function isNonNegativeNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
export function isPositiveInteger(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

// 返回输入中不在 known 集合内的字段名（非对象输入返回空）
export function unknownFields(input, known) {
  if (!isObject(input)) return [];
  return Object.keys(input).filter((k) => !known.has(k));
}
