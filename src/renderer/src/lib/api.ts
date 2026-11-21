import type {
  ContentContext, ContentContextInput, ContentSeries, ContentSeriesInput, PromptPreview, Script, ScriptRequest,
  Account, AiProgress, Job, AnalyticsData, DashboardData, LogEntry, Plan, PlannerBrief, Platform, Post, PostInput, SecretField, Settings, SiteAnalysis, Variant
} from '@shared/types'
import { t } from './i18n'

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = await window.allin.invoke(channel, ...args)
  if (!r.ok) throw new Error(r.error ?? t('Error desconocido'))
  return r.data as T
}

export interface AppInfo { version: string; dataPath: string; encryption: string; redirectUri: string; platform: string }
export interface SyncReport { platform: Platform | 'ga4'; ok: boolean; message: string }
export interface ManualMetrics { views: number; likes: number; comments: number; shares: number; saves: number }

export const api = {
  posts: {
    list: (from?: string, to?: string) => call<Post[]>('posts:list', from, to),
    get: (id: string) => call<Post | null>('posts:get', id),
    save: (id: string | null, input: PostInput) => call<Post>('posts:save', id, input),
    remove: (id: string) => call<void>('posts:delete', id),
    publishNow: (id: string) => call<Post>('posts:publishNow', id)
  },
  ai: {
    plan: (brief: PlannerBrief) => call<Plan>('ai:plan', brief),
    plans: () => call<Plan[]>('ai:plans'),
    analyzeSite: (url: string) => call<SiteAnalysis>('ai:analyzeSite', url),
    claudeCodeStatus: () => call<{ ok: boolean; path: string; version: string; loggedIn: boolean; plan: string; error: string }>('ai:claudeCodeStatus'),
    acceptPlan: (plan: Plan, indexes: number[], status: 'draft' | 'scheduled') => call<number>('ai:acceptPlan', plan, indexes, status),
    variants: (postId: string, platforms: Platform[]) => call<Variant[]>('ai:variants', postId, platforms),
    article: (postId: string) => call<{ title: string; markdown: string }>('ai:article', postId)
  },
  content: {
    contexts: () => call<ContentContext[]>('content:contexts'),
    saveContext: (id: string | null, input: ContentContextInput) => call<ContentContext>('content:saveContext', id, input),
    archiveContext: (id: string) => call<void>('content:archiveContext', id),
    addImages: (id: string) => call<ContentContext | null>('content:addImages', id),
    removeImage: (id: string, file: string) => call<ContentContext>('content:removeImage', id, file),
    addParts: (id: string) => call<ContentContext>('content:addParts', id),
    updatePart: (id: string, file: string, patch: { name?: string; note?: string }) => call<ContentContext>('content:updatePart', id, file, patch),
    removePart: (id: string, file: string) => call<ContentContext>('content:removePart', id, file),
    sceneryPrompt: (id: string, styleId: string | null, vertical: boolean) => call<string>('content:sceneryPrompt', id, styleId, vertical),
    image: (file: string) => call<string>('content:image', file),
    sheetPrompt: (id: string, styleId: string | null) => call<string>('content:sheetPrompt', id, styleId),
    series: () => call<ContentSeries[]>('content:series'),
    saveSeries: (id: string | null, input: ContentSeriesInput) => call<ContentSeries>('content:saveSeries', id, input),
    archiveSeries: (id: string) => call<void>('content:archiveSeries', id),
    scripts: () => call<Script[]>('content:scripts'),
    previewPrompt: (req: ScriptRequest) => call<PromptPreview>('content:previewPrompt', req),
    generate: (req: ScriptRequest) => call<Job>('content:generate', req),
    generateVideo: (id: string) => call<Job>('content:generateVideo', id),
    regenerateScene: (id: string, index: number, note: string) => call<Job>('content:regenerateScene', id, index, note),
    updateScript: (id: string, patch: Partial<Script>) => call<Script>('content:updateScript', id, patch),
    deleteScript: (id: string) => call<void>('content:deleteScript', id),
    scriptText: (id: string) => call<string>('content:scriptText', id),
    toPost: (id: string, scheduledAt: string, status: 'draft' | 'scheduled') => call<Post>('content:toPost', id, scheduledAt, status)
  },
  calendar: {
    exportIcs: () => call<{ file: string; count: number } | null>('calendar:exportIcs'),
    gcalSync: () => call<{ created: number; updated: number; deleted: number }>('calendar:gcalSync')
  },
  stats: {
    dashboard: (days?: number) => call<DashboardData>('stats:dashboard', days),
    analytics: (days?: number) => call<AnalyticsData>('stats:analytics', days)
  },
  metrics: {
    sync: () => call<SyncReport[]>('metrics:sync'),
    manual: (targetId: string, m: ManualMetrics) => call<void>('metrics:manual', targetId, m)
  },
  settings: {
    get: () => call<Settings>('settings:get'),
    save: (patch: Partial<Settings>) => call<Settings>('settings:save', patch)
  },
  secrets: {
    status: () => call<Record<SecretField, boolean>>('secrets:status'),
    set: (field: SecretField, value: string) => call<void>('secrets:set', field, value),
    peek: (field: SecretField) => call<string>('secrets:peek', field)
  },
  accounts: {
    list: () => call<Account[]>('accounts:list'),
    connect: (p: Platform | 'ga4' | 'gcal') => call<string>('accounts:connect', p),
    disconnect: (p: Platform | 'ga4' | 'gcal') => call<void>('accounts:disconnect', p)
  },
  app: {
    info: () => call<AppInfo>('app:info'),
    logs: () => call<LogEntry[]>('app:logs'),
    openExternal: (url: string) => call<void>('app:openExternal', url),
    showItem: (path: string) => call<void>('app:showItem', path),
    pickFile: (kind: 'media' | 'json') => call<string | null>('app:pickFile', kind),
    readJson: () => call<string | null>('app:readJson'),
    pickFolder: () => call<string | null>('app:pickFolder')
  },
  jobs: {
    list: () => call<Job[]>('jobs:list'),
    dismiss: (id: string) => call<void>('jobs:dismiss', id)
  },
  demo: {
    load: () => call<void>('demo:load'),
    clear: () => call<void>('demo:clear'),
    has: () => call<boolean>('demo:has')
  },
  onChanged: (fn: () => void) => window.allin.on('changed', fn),
  onJobs: (fn: (jobs: Job[]) => void) => window.allin.on('jobs', (j) => fn(j as Job[])),
  onAiProgress: (fn: (p: AiProgress) => void) => window.allin.on('ai-progress', (p) => fn(p as AiProgress))
}
