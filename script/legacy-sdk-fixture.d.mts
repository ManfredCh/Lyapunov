/** 从固定Git对象和原已签旧patch自造source-only fixture；不会装/运行旧底座。 */
export function legacySDKFixture(root: string): string
/** 显式准备：主动获取公开旧源码并验签；默认测试不会调用。 */
export function prepareLegacySDKFixture(root: string, target: string): string
