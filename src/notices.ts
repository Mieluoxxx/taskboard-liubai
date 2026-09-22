import type { Language } from './types'

/**
 * 用户可见的运行时提示统一用 code 传递，再由 i18n 渲染。
 * 领域层与适配器只负责抛出/返回 code，不再把某种语言的句子直接送进界面。
 */
export const noticeCopy = {
  zh: {
    noticeTimerBusy: '另有一个专注计时器正在运行，请先结束它。',
    noticeTimerDuration: '时长必须是 0 到 1440 之间分钟数。',
    noticeTimerFinished: '已结束的专注块不能重新开始。',
    noticeTimerLocked: '开始后不能修改时长。',
    noticeTimerMissing: '专注块不存在或时间戳无效。',
    noticeTaskMissing: '任务不存在或已被删除。',
    noticeCycleInvalid: '周期需要名称，且结束日期不能早于开始日期。',
    noticeCycleMissing: '周期不存在。',
    noticeRescheduleInvalid: '只能把未完成的日任务或周任务顺延到更晚的周期。',
    noticeRescheduleOutsideCycle: '目标日期超出所属项目周期，请先调整项目的起止日期。',
    noticeBoardInvalid: '本地数据格式无效，已拒绝保存。',
    noticeInvalidState: '收到的数据格式无效，已拒绝写入。',
    noticeOffline: '当前处于离线状态，保存已暂停；草稿仍保留在当前页面。',
    noticeConflictCloud: '云端版本已变化，请加载最新内容后手动合并草稿。',
    noticeConflictDemo: '本地演示板已在另一个页面更新，请重新加载。',
    noticeWrongOwner: '当前账号暂时无法访问看板，请管理员确认已执行独立看板迁移。',
    noticeSessionExpired: '登录会话已失效，请重新登录。',
    noticeCloudError: '云端请求失败，请稍后重试。',
    noticeInvalidCredentials: '邮箱或密码不正确，或云端认证尚未完成配置。',
    noticeDemoInvalid: '本地演示数据无效。',
    noticeOperationFailed: '操作未完成，请重试。',
    noticeTaskSaveFailed: '任务未保存。',
    noticeCycleSaveFailed: '周期未保存。',
    noticeFocusSaveFailed: '专注块未保存。',
    noticeSaveInProgress: '保存仍在进行，请稍后再刷新。',
    noticeReapplyDraft: '已加载最新内容；你之前填写的草稿输入仍保留着，可以重新打开编辑器继续。',
  },
  en: {
    noticeTimerBusy: 'Another focus timer is already running; finish it first.',
    noticeTimerDuration: 'Duration must be a number of minutes between 0 and 1440.',
    noticeTimerFinished: 'A finished focus block cannot be restarted.',
    noticeTimerLocked: 'The duration cannot change after the timer starts.',
    noticeTimerMissing: 'The focus block is missing or its timestamp is invalid.',
    noticeTaskMissing: 'The task is missing or was already deleted.',
    noticeCycleInvalid: 'A cycle needs a name, and its end date cannot precede its start date.',
    noticeCycleMissing: 'The cycle no longer exists.',
    noticeRescheduleInvalid: 'Only an active daily or weekly task can be moved to a later period.',
    noticeRescheduleOutsideCycle: 'The target is outside this project cycle. Adjust the cycle dates first.',
    noticeBoardInvalid: 'The local data shape is invalid; the save was rejected.',
    noticeInvalidState: 'The received data shape is invalid; the write was rejected.',
    noticeOffline: 'You are offline, so saving is paused. Your draft is still on this page.',
    noticeConflictCloud: 'The cloud version changed; load the latest and merge your draft manually.',
    noticeConflictDemo: 'The demo board changed in another tab; reload it.',
    noticeWrongOwner: 'This account cannot access the board yet. Ask an administrator to apply the independent-board migration.',
    noticeSessionExpired: 'The sign-in session expired. Please sign in again.',
    noticeCloudError: 'The cloud request failed. Try again later.',
    noticeInvalidCredentials: 'The email or password is incorrect, or Supabase is not provisioned yet.',
    noticeDemoInvalid: 'The local demo data is invalid.',
    noticeOperationFailed: 'The operation did not complete. Try again.',
    noticeTaskSaveFailed: 'The task was not saved.',
    noticeCycleSaveFailed: 'The cycle was not saved.',
    noticeFocusSaveFailed: 'The focus block was not saved.',
    noticeSaveInProgress: 'A save is still in progress; refresh again shortly.',
    noticeReapplyDraft: 'The latest content is loaded; the input you had filled in is still retained so you can continue editing.',
  },
} as const satisfies Record<Language, Record<string, string>>

export type NoticeCode = keyof typeof noticeCopy.zh

const noticeCodes = new Set<string>(Object.keys(noticeCopy.zh))

export function isNoticeCode(value: unknown): value is NoticeCode {
  return typeof value === 'string' && noticeCodes.has(value)
}

/** 带 code 的错误：code 用于界面本地化，message 仍保留英文诊断文本供日志与测试使用。 */
export class BoardError extends Error {
  readonly code: NoticeCode

  constructor(code: NoticeCode, message: string) {
    super(message)
    this.name = 'BoardError'
    this.code = code
  }
}
