// 人群外观目录覆盖的环境键单独成叶模块：script/profile.ts 只取这一个常量，
// 不能把 rocketbox-catalog（经 glb.ts 拉 three）整包带进桌面主进程闭包。
export const HUMAN_AVATAR_ROOT_ENV='LYAPUNOV_HUMAN_AVATAR_ROOT'
