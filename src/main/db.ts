import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Channel, LogEntry, MetricSnapshot, Platform, Post, PostInput, PostStatus, PostTarget, Settings, TargetStatus
} from '@shared/types'
import { PLATFORM_IDS } from '@shared/types'

let db: Database.Database

const SCHEMA = `
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'text',
  pillar TEXT NOT NULL DEFAULT '',
  hook TEXT NOT NULL DEFAULT '',
  cta TEXT NOT NULL DEFAULT '',
  link_path TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  media_path TEXT NOT NULL DEFAULT '',
  media_public_url TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  source TEXT NOT NULL DEFAULT 'manual',
  rationale TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_at);

CREATE TABLE IF NOT EXISTS post_targets (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  remote_id TEXT,
  remote_url TEXT,
  error TEXT,
  published_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE(post_id, platform)
);

-- Instantáneas diarias de métricas acumuladas por publicación y plataforma.
CREATE TABLE IF NOT EXISTS metric_snapshots (
  target_id TEXT NOT NULL REFERENCES post_targets(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  saves INTEGER NOT NULL DEFAULT 0,
  manual INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (target_id, date)
);

-- Sesiones diarias en la web por canal y campaña UTM (desde GA4).
CREATE TABLE IF NOT EXISTS web_traffic (
  date TEXT NOT NULL,
  channel TEXT NOT NULL,
  campaign TEXT NOT NULL DEFAULT '',
  sessions INTEGER NOT NULL DEFAULT 0,
  users INTEGER NOT NULL DEFAULT 0,
  demo INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, channel, campaign)
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  platform TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  connected_at TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  scope TEXT NOT NULL,
  message TEXT NOT NULL
);
`

export function openDb(): Database.Database {
  const file = join(app.getPath('userData'), 'allinmkt.db')
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}

export function getDb(): Database.Database {
  return db
}

const now = (): string => new Date().toISOString()

// ---------- Settings ----------

export const DEFAULT_SETTINGS: Settings = {
  website: '',
  language: 'es',
  aiProvider: 'claude-code',
  claudePath: '',
  anthropicModel: 'claude-opus-5-5',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  autostart: false,
  closeToTray: true,
  syncHours: 6,
  oauthPort: 8765,
  overdueGraceHours: 12,
  tiktokPrivacy: 'SELF_ONLY',
  youtubePrivacy: 'public',
  igApiVersion: 'v24.0',
  linkedinVersion: '',
  blogMode: 'markdown',
  wordpressUrl: '',
  wordpressUser: '',
  markdownFolder: '',
  ga4PropertyId: '',
  storageEndpoint: '',
  storageRegion: 'auto',
  storageBucket: '',
  storagePublicBaseUrl: '',
  plannerBrief: null,
  plannerAnalysis: null
}

export function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const r of rows) s[r.key] = JSON.parse(r.value)
  return s as unknown as Settings
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const stmt = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) stmt.run(k, JSON.stringify(v))
  })
  tx()
  return getSettings()
}

// ---------- Logs ----------

export function log(level: LogEntry['level'], scope: string, message: string): void {
  db.prepare('INSERT INTO logs(ts, level, scope, message) VALUES (?, ?, ?, ?)').run(now(), level, scope, message)
  db.prepare('DELETE FROM logs WHERE id < (SELECT MAX(id) - 500 FROM logs)').run()
  if (level === 'error') console.error(`[${scope}] ${message}`)
}

export function listLogs(limit = 100): LogEntry[] {
  return db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit) as LogEntry[]
}

// ---------- Posts ----------

interface PostRow {
  id: string; title: string; body: string; format: string; pillar: string; hook: string; cta: string
  link_path: string; utm_campaign: string; media_path: string; media_public_url: string; scheduled_at: string
  status: string; source: string; rationale: string; notes: string; created_at: string; updated_at: string
}
interface TargetRow {
  id: string; post_id: string; platform: string; caption: string; title: string; status: string
  remote_id: string | null; remote_url: string | null; error: string | null; published_at: string | null
}

const toTarget = (r: TargetRow): PostTarget => ({
  id: r.id, postId: r.post_id, platform: r.platform as Platform, caption: r.caption, title: r.title,
  status: r.status as TargetStatus, remoteId: r.remote_id, remoteUrl: r.remote_url, error: r.error, publishedAt: r.published_at
})

function hydrate(rows: PostRow[]): Post[] {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const targets = db
    .prepare(`SELECT * FROM post_targets WHERE post_id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as TargetRow[]
  const byPost = new Map<string, PostTarget[]>()
  for (const t of targets) {
    const list = byPost.get(t.post_id) ?? []
    list.push(toTarget(t))
    byPost.set(t.post_id, list)
  }
  const order = (p: Platform): number => PLATFORM_IDS.indexOf(p)
  return rows.map((r) => ({
    id: r.id, title: r.title, body: r.body, format: r.format as Post['format'], pillar: r.pillar, hook: r.hook, cta: r.cta,
    linkPath: r.link_path, utmCampaign: r.utm_campaign, mediaPath: r.media_path, mediaPublicUrl: r.media_public_url,
    scheduledAt: r.scheduled_at, status: r.status as PostStatus, source: r.source as Post['source'], rationale: r.rationale,
    notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
    targets: (byPost.get(r.id) ?? []).sort((a, b) => order(a.platform) - order(b.platform))
  }))
}

export function listPosts(from?: string, to?: string): Post[] {
  const rows = (
    from && to
      ? db.prepare('SELECT * FROM posts WHERE scheduled_at >= ? AND scheduled_at < ? ORDER BY scheduled_at').all(from, to)
      : db.prepare('SELECT * FROM posts ORDER BY scheduled_at').all()
  ) as PostRow[]
  return hydrate(rows)
}

export function getPost(id: string): Post | null {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as PostRow | undefined
  return row ? hydrate([row])[0] : null
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export function upsertPost(id: string | null, input: PostInput): Post {
  const existing = id ? getPost(id) : null
  const postId = existing?.id ?? randomUUID()
  const merged = {
    title: input.title ?? existing?.title ?? '',
    body: input.body ?? existing?.body ?? '',
    format: input.format ?? existing?.format ?? 'text',
    pillar: input.pillar ?? existing?.pillar ?? '',
    hook: input.hook ?? existing?.hook ?? '',
    cta: input.cta ?? existing?.cta ?? '',
    linkPath: input.linkPath ?? existing?.linkPath ?? '',
    utmCampaign: input.utmCampaign ?? existing?.utmCampaign ?? '',
    mediaPath: input.mediaPath ?? existing?.mediaPath ?? '',
    mediaPublicUrl: input.mediaPublicUrl ?? existing?.mediaPublicUrl ?? '',
    scheduledAt: input.scheduledAt ?? existing?.scheduledAt ?? now(),
    status: input.status ?? existing?.status ?? 'draft',
    source: input.source ?? existing?.source ?? 'manual',
    rationale: input.rationale ?? existing?.rationale ?? '',
    notes: input.notes ?? existing?.notes ?? ''
  }
  if (!merged.utmCampaign) merged.utmCampaign = `${merged.scheduledAt.slice(0, 10)}-${slugify(merged.title || 'post')}`.slice(0, 80)

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE posts SET title=?, body=?, format=?, pillar=?, hook=?, cta=?, link_path=?, utm_campaign=?, media_path=?,
         media_public_url=?, scheduled_at=?, status=?, source=?, rationale=?, notes=?, updated_at=? WHERE id=?`
      ).run(merged.title, merged.body, merged.format, merged.pillar, merged.hook, merged.cta, merged.linkPath, merged.utmCampaign,
        merged.mediaPath, merged.mediaPublicUrl, merged.scheduledAt, merged.status, merged.source, merged.rationale, merged.notes, now(), postId)
    } else {
      db.prepare(
        `INSERT INTO posts (id, title, body, format, pillar, hook, cta, link_path, utm_campaign, media_path, media_public_url,
         scheduled_at, status, source, rationale, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(postId, merged.title, merged.body, merged.format, merged.pillar, merged.hook, merged.cta, merged.linkPath, merged.utmCampaign,
        merged.mediaPath, merged.mediaPublicUrl, merged.scheduledAt, merged.status, merged.source, merged.rationale, merged.notes, now(), now())
    }

    if (input.platforms) {
      const keep = new Set(input.platforms)
      for (const t of existing?.targets ?? []) {
        if (!keep.has(t.platform) && t.status !== 'published') db.prepare('DELETE FROM post_targets WHERE id = ?').run(t.id)
      }
      for (const p of input.platforms) {
        db.prepare('INSERT INTO post_targets (id, post_id, platform) VALUES (?, ?, ?) ON CONFLICT(post_id, platform) DO NOTHING').run(randomUUID(), postId, p)
      }
    }
    for (const [platform, o] of Object.entries(input.targetOverrides ?? {})) {
      if (!o) continue
      if (o.caption !== undefined) db.prepare('UPDATE post_targets SET caption = ? WHERE post_id = ? AND platform = ?').run(o.caption, postId, platform)
      if (o.title !== undefined) db.prepare('UPDATE post_targets SET title = ? WHERE post_id = ? AND platform = ?').run(o.title, postId, platform)
    }
    // Reprogramar una publicación fallida vuelve a dejar pendientes sus destinos.
    if (input.status === 'scheduled') {
      db.prepare("UPDATE post_targets SET status='pending', error=NULL WHERE post_id=? AND status IN ('failed','skipped')").run(postId)
    }
  })
  tx()
  return getPost(postId)!
}

export function deletePost(id: string): void {
  db.prepare('DELETE FROM posts WHERE id = ?').run(id)
}

export function updateTarget(id: string, patch: Partial<{ status: TargetStatus; remoteId: string | null; remoteUrl: string | null; error: string | null; publishedAt: string | null }>): void {
  const cols: string[] = []
  const vals: unknown[] = []
  const map: Record<string, string> = { status: 'status', remoteId: 'remote_id', remoteUrl: 'remote_url', error: 'error', publishedAt: 'published_at' }
  for (const [k, v] of Object.entries(patch)) {
    cols.push(`${map[k]} = ?`)
    vals.push(v)
  }
  if (patch.status === 'publishing') cols.push('attempts = attempts + 1')
  if (cols.length) db.prepare(`UPDATE post_targets SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id)
}

/** Recalcula el estado del post a partir de sus destinos. */
export function refreshPostStatus(postId: string): void {
  const post = getPost(postId)
  if (!post || post.targets.length === 0) return
  const s = post.targets.map((t) => t.status)
  let status: PostStatus = post.status
  if (s.every((x) => x === 'published' || x === 'skipped')) status = 'published'
  else if (s.some((x) => x === 'publishing')) status = 'publishing'
  else if (s.some((x) => x === 'published') && s.some((x) => x === 'failed')) status = 'partial'
  else if (s.every((x) => x === 'failed' || x === 'skipped')) status = 'failed'
  db.prepare('UPDATE posts SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), postId)
}

export interface DueTarget { target: PostTarget; post: Post }

export function dueTargets(nowIso: string): DueTarget[] {
  const rows = db
    .prepare(
      `SELECT t.id AS tid, t.post_id AS pid FROM post_targets t JOIN posts p ON p.id = t.post_id
       WHERE p.status IN ('scheduled', 'publishing', 'partial') AND t.status = 'pending' AND p.scheduled_at <= ?`
    )
    .all(nowIso) as { tid: string; pid: string }[]
  const out: DueTarget[] = []
  for (const r of rows) {
    const post = getPost(r.pid)
    const target = post?.targets.find((t) => t.id === r.tid)
    if (post && target) out.push({ post, target })
  }
  return out
}

export function publishedTargets(platform: Platform, sinceIso: string): PostTarget[] {
  return (
    db
      .prepare("SELECT * FROM post_targets WHERE platform = ? AND status = 'published' AND remote_id IS NOT NULL AND remote_id NOT LIKE 'demo-%' AND published_at >= ?")
      .all(platform, sinceIso) as TargetRow[]
  ).map(toTarget)
}

// ---------- Métricas y tráfico ----------

export function upsertSnapshot(s: MetricSnapshot, manual = false): void {
  db.prepare(
    `INSERT INTO metric_snapshots (target_id, date, views, likes, comments, shares, saves, manual) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(target_id, date) DO UPDATE SET views=excluded.views, likes=excluded.likes, comments=excluded.comments,
     shares=excluded.shares, saves=excluded.saves, manual=excluded.manual`
  ).run(s.targetId, s.date, s.views, s.likes, s.comments, s.shares, s.saves, manual ? 1 : 0)
}

export function replaceTraffic(rows: { date: string; channel: Channel; campaign: string; sessions: number; users: number }[], from: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM web_traffic WHERE date >= ? AND demo = 0').run(from)
    const stmt = db.prepare(
      `INSERT INTO web_traffic (date, channel, campaign, sessions, users) VALUES (?,?,?,?,?)
       ON CONFLICT(date, channel, campaign) DO UPDATE SET sessions = sessions + excluded.sessions, users = users + excluded.users`
    )
    for (const r of rows) stmt.run(r.date, r.channel, r.campaign, r.sessions, r.users)
  })
  tx()
}

// ---------- Cuentas ----------

export function setAccount(platform: string, displayName: string, meta: Record<string, unknown> = {}): void {
  db.prepare(
    `INSERT INTO accounts (platform, display_name, connected_at, meta) VALUES (?,?,?,?)
     ON CONFLICT(platform) DO UPDATE SET display_name=excluded.display_name, connected_at=excluded.connected_at, meta=excluded.meta`
  ).run(platform, displayName, now(), JSON.stringify(meta))
}

export function getAccount(platform: string): { displayName: string; connectedAt: string; meta: Record<string, unknown> } | null {
  const r = db.prepare('SELECT * FROM accounts WHERE platform = ?').get(platform) as
    | { display_name: string; connected_at: string; meta: string }
    | undefined
  return r ? { displayName: r.display_name, connectedAt: r.connected_at, meta: JSON.parse(r.meta) } : null
}

export function removeAccount(platform: string): void {
  db.prepare('DELETE FROM accounts WHERE platform = ?').run(platform)
}

// ---------- Planes ----------

export function savePlan(id: string, createdAt: string, data: unknown): void {
  db.prepare('INSERT OR REPLACE INTO plans (id, created_at, data) VALUES (?,?,?)').run(id, createdAt, JSON.stringify(data))
}

export function listPlans<T>(): T[] {
  return (db.prepare('SELECT data FROM plans ORDER BY created_at DESC LIMIT 20').all() as { data: string }[]).map((r) => JSON.parse(r.data) as T)
}
