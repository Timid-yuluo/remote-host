/**
 * 轻量激活入口：每次激活都用带时间戳的新模块地址加载实现，
 * 使修改后的 Host 代码无需改文件名或重启进程即可生效。
 */
export const inject = ['connection', 'tools', 'webServer'];

export async function apply(ctx) {
  const implementation = await import(`./app.js?v=${Date.now()}`);
  return implementation.apply(ctx);
}
