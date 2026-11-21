import type { Platform } from '@shared/types'
import type { Connector } from './types'
import { tiktok } from './tiktok'
import { instagram } from './instagram'
import { youtube } from './youtube'
import { linkedin } from './linkedin'
import { x } from './x'
import { blog } from './blog'

export const connectors: Record<Platform, Connector> = { tiktok, instagram, youtube, linkedin, x, blog }
export { ga4 } from './ga4'
