export function workflowErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '流程暂停，请检查连接';
  if (/平台浏览器启动失败|launchPersistentContext|<launching>/.test(error.message))
    return '平台浏览器启动失败，尚未进入页面采集；已保留任务，请重启内置浏览器服务后继续，详细诊断见任务记录';
  if (/locator\.|Timeout .*exceeded/.test(error.message))
    return '平台页面控件未及时响应，已保留任务；请检查平台窗口后继续，详细诊断见任务记录';
  return error.message;
}
