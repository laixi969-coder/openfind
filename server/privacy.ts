// Apply at the outbound boundary, including material assembled from method cards.
export function redactModelText(value: string) {
  return value
    .replace(/https?:\/\/\S+/gi, '[链接地址已隐藏]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱已隐藏]')
    .replace(/\+?\d[\d\s-]{9,}\d/g, '[号码已隐藏]')
    .replace(
      /(?:微信|微信|WeChat|wechat|wx|VX)\s*[:：号]?\s*[A-Za-z][\w-]{5,19}/g,
      '[联系方式已隐藏]',
    );
}

export function redactModelContent(content: string) {
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return redactModelText(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, visit(value)]));
    return value;
  };
  try {
    return JSON.stringify(visit(JSON.parse(content)));
  } catch {
    return redactModelText(content);
  }
}
